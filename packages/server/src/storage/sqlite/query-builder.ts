import type { Filter } from '@nostr-cache/shared';
import { type SQL, and, gte, inArray, lte } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { events, eventTags } from './schema.js';

/**
 * NIP-01 filter → Drizzle 条件式の変換（SQLite ストレージアダプタ用）。
 *
 * Dexie 実装（cache-relay の `dexie/query-builder.ts`）と同じ二段構え:
 * SQL（インデックス）は候補を「絞る」だけで、最終判定は共通の
 * `filterUtils.eventMatchesFilter` が完全なイベントに対して行う。
 * したがってここで押し込む条件は「取りこぼしを生まない」ものに限る。
 *
 * 特にタグ条件（`#e` / `#p` …）は、タグ主導の分岐（ids / authors / kinds が
 * ない場合）でのみ `event_tags` テーブルで絞り込む。それ以外の分岐で
 * `event_tags` への絞り込みを押し込むと、インデックス上限（getIndexedTags の
 * 100 件キャップ）で `event_tags` から欠落したタグを持つイベントが誤って
 * 除外される（最終判定は完全な tags 配列に対して行われるため一致し得る）。
 * これは Dexie 実装と同一の設計判断。
 */

/**
 * 単一の IN 句に押し込むパラメータ数の上限。超える場合はその条件を SQL に
 * 押し込まず、最終の JS 判定に委ねる（結果は正しいまま、絞り込みだけ粗くなる）。
 * SQLite のバインド変数上限（既定 32766）への防御。
 */
const MAX_IN_PARAMS = 500;

/**
 * Built narrowing condition for a single filter.
 */
export interface BuiltFilterQuery {
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
 * Stage A: reject filters whose tag conditions are malformed.
 *
 * Dexie 実装の `eventRowMatchesFilter` の追加検証と同じ条件:
 * `#x` のタグ名が単一英字でない、値が配列でない、または空・非文字列の値を
 * 含むフィルタは何にもマッチしない（結果は空）。
 *
 * @param filter Filter to inspect
 * @returns true if the filter can never match (malformed tag condition)
 */
export function hasInvalidTagFilter(filter: Filter): boolean {
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const tagName = key.slice(1);
    if (tagName.length !== 1 || !/^[a-zA-Z]$/.test(tagName)) {
      return true;
    }
    if (!Array.isArray(values) || values.some((v) => !v || typeof v !== 'string')) {
      return true;
    }
  }
  return false;
}

/**
 * Stage B: build the narrowing WHERE condition for a single (well-formed)
 * filter.
 *
 * 押し込む条件はすべて最終判定（`eventMatchesFilter`）と等価な完全一致 / 範囲
 * 条件のみ: `id IN` / `pubkey IN` / `kind IN` / `created_at >= since` /
 * `created_at <= until`（since / until は truthy のときのみ —
 * `eventMatchesFilter` の `filter.since &&` と同じ挙動）。
 *
 * @param db Drizzle database handle (タグ主導分岐のサブクエリ構築に使用)
 * @param filter Filter conditions (must have passed {@link hasInvalidTagFilter})
 * @returns Narrowing condition and whether it is complete
 */
export function buildFilterQuery(db: NodeSQLiteDatabase, filter: Filter): BuiltFilterQuery {
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

  if (since) {
    conditions.push(gte(events.createdAt, since));
  }
  if (until) {
    conditions.push(lte(events.createdAt, until));
  }

  return {
    where: conditions.length > 0 ? and(...conditions) : undefined,
    complete: !narrowingIncomplete,
  };
}
