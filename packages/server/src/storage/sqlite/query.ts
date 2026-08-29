/**
 * How a filter is answered from the SQLite tables.
 *
 * 1 つのフィルタの読み方（絞り込み条件・並び・切り詰め）はすべてこのモジュールが
 * 持ち、`SqliteStorage` は接続を渡して結果を統合するだけ。cache-relay の
 * `dexie/query.ts` と同じ二段構えで、SQL（インデックス）は候補を「絞る」だけ、
 * 最終判定は共通の `filterUtils.eventMatchesFilter` が完全なイベントに対して行う。
 * したがってここで押し込む条件は「取りこぼしを生まない」ものに限る。
 *
 * 特にタグ条件（`#e` / `#p` …）は、タグ主導の分岐（ids / authors / kinds が
 * ない場合）でのみ `event_tags` テーブルで絞り込む。それ以外の分岐で
 * `event_tags` への絞り込みを押し込むと、インデックス上限（getIndexedTags の
 * 100 件キャップ）で `event_tags` から欠落したタグを持つイベントが誤って
 * 除外される（最終判定は完全な tags 配列に対して行われるため一致し得る）。
 * これは Dexie 実装と同一の設計判断。
 */

import { filterUtils } from '@nostr-cache/cache-relay';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { type SQL, and, asc, desc, gte, inArray, lte } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { events, type EventRow, eventTags, rowToEvent } from './schema.js';

/**
 * 単一の IN 句に押し込むパラメータ数の上限。超える場合はその条件を SQL に
 * 押し込まず、最終の JS 判定に委ねる（結果は正しいまま、絞り込みだけ粗くなる）。
 * SQLite のバインド変数上限（既定 32766）への防御。
 */
const MAX_IN_PARAMS = 500;

/** Built narrowing condition for a single filter. */
interface BuiltFilterQuery {
  /** WHERE 条件（絞り込み条件が無い場合は undefined = 全件走査） */
  where: SQL | undefined;
  /**
   * SQL の絞り込みが最終判定（eventMatchesFilter）と完全等価なら true。
   * false の場合、SQL 段階で LIMIT すると取りこぼしが生じるため、
   * 呼び出し側は JS 判定後にのみ切り詰めてよい
   */
  complete: boolean;
}

/**
 * Stage B: build the narrowing WHERE condition for a single (well-formed)
 * filter.
 *
 * 押し込む条件はすべて最終判定（`eventMatchesFilter`）と等価な完全一致 / 範囲
 * 条件のみ: `id IN` / `pubkey IN` / `kind IN` / `created_at >= since` /
 * `created_at <= until`。
 */
function buildFilterQuery(db: NodeSQLiteDatabase, filter: Filter): BuiltFilterQuery {
  const { ids, authors, kinds, since, until, ...rest } = filter;
  const conditions: SQL[] = [];

  // 単一英字タグフィルタを "k:v" 形式へ平坦化（全 #x キーの合併。
  // キーごとの AND は最終判定が担う — Dexie の anyOf(indexedTagValues) と同じ）
  const tagValues: string[] = [];
  let hasTagFilter = false;
  for (const [key, values] of Object.entries(rest)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    hasTagFilter = true;
    const tagName = key.slice(1);
    for (const value of values) {
      if (value && typeof value === 'string') {
        tagValues.push(`${tagName}:${value}`);
      }
    }
  }

  // SQL の絞り込みが最終判定と完全一致しない（JS 判定で行が落ち得る）場合に
  // true。この場合 SQL 段階の LIMIT は取りこぼしを生む
  let narrowingIncomplete = hasTagFilter;

  const addInCondition = (
    column: typeof events.id | typeof events.pubkey | typeof events.kind,
    values: (string | number)[] | undefined
  ) => {
    // 空配列は条件を押し込まない（最終判定が「何にもマッチしない」を担うため、
    // LIMIT の安全性にも影響しない）
    if (!values || values.length === 0) return;
    // 上限超過時も押し込まず、粗い候補を最終判定に委ねる
    if (values.length > MAX_IN_PARAMS) {
      narrowingIncomplete = true;
      return;
    }
    conditions.push(inArray(column, values as string[] & number[]));
  };

  if (tagValues.length > 0 && !ids?.length && !authors?.length && !kinds?.length) {
    // タグ主導の分岐: event_tags で絞る（Dexie の indexed_tags 分岐に対応）
    if (tagValues.length <= MAX_IN_PARAMS) {
      const matchingIds = db
        .select({ id: eventTags.eventId })
        .from(eventTags)
        .where(inArray(eventTags.tag, tagValues));
      conditions.push(inArray(events.id, matchingIds));
    }
  } else {
    addInCondition(events.id, ids);
    addInCondition(events.pubkey, authors);
    addInCondition(events.kind, kinds);
  }

  // `!== undefined` で判定する（truthy 判定だと `since: 0` / `until: 0` が
  // 「指定なし」扱いになり、共通判定 eventMatchesFilter や Dexie 実装と割れる）
  if (since !== undefined) {
    conditions.push(gte(events.createdAt, since));
  }
  if (until !== undefined) {
    conditions.push(lte(events.createdAt, until));
  }

  return {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    complete: !narrowingIncomplete,
  };
}

/**
 * Answer one filter: narrow in SQL, validate in JS, truncate to NIP-01's
 * `limit`.
 *
 * 切り詰めは「新しい順」（`capEvents` と同じ規則、id は決定性のためのタイブレーク）。
 * SQL 段階の LIMIT は Stage B の絞り込みが最終判定と完全等価な場合のみで、
 * そうでなければ Stage C の後に切り詰める。
 */
export function queryEvents(db: NodeSQLiteDatabase, filter: Filter): NostrEvent[] {
  // Stage A: 不正なタグ条件を持つフィルタは何にもマッチしない
  if (filterUtils.rejectsEveryRow(filter)) {
    return [];
  }

  // Stage B: インデックスで候補を絞る
  const { where, complete } = buildFilterQuery(db, filter);
  let query = db.select().from(events).where(where).$dynamic();
  // 非負整数へ正規化する（SQLite の LIMIT は小数を受け付けずクエリ全体が失敗するため、
  // クライアントから `limit: 1.5` が来ただけで空応答になってしまう）。Dexie 実装も同じ正規化
  const limit = filterUtils.normalizeLimit(filter.limit);
  if (limit !== undefined) {
    query = query.orderBy(desc(events.createdAt), asc(events.id));
    if (complete) {
      query = query.limit(limit);
    }
  }
  const rows: EventRow[] = query.all();

  // Stage C: 完全なイベントに対する最終判定（Dexie と同じ共通実装）
  const matched = rows
    .map(rowToEvent)
    .filter((event) => filterUtils.eventMatchesFilter(event, filter));
  return limit !== undefined ? matched.slice(0, limit) : matched;
}
