import type { Filter } from '@nostr-cache/shared';

/**
 * NIP-01 filter → SQL translation for the SQLite storage adapter.
 *
 * Dexie 実装（cache-relay の `dexie/query-builder.ts`）と同じ二段構え:
 * SQL（インデックス）は候補を「絞る」だけで、最終判定は共通の
 * `filterUtils.eventMatchesFilter` が完全なイベントに対して行う。
 * したがってここで押し込む条件は「取りこぼしを生まない」ものに限る。
 *
 * 特にタグ条件（`#e` / `#p` …）は、タグ主導の分岐（ids / authors / kinds が
 * ない場合）でのみ `event_tags` テーブルで絞り込む。それ以外の分岐で
 * `event_tags` への EXISTS を押し込むと、インデックス上限（getIndexedTags の
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
 * Built SQL query for a single filter.
 */
export interface BuiltFilterQuery {
  sql: string;
  params: (string | number)[];
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
 * Stage B: build the narrowing SELECT for a single (well-formed) filter.
 *
 * 押し込む条件はすべて最終判定（`eventMatchesFilter`）と等価な完全一致 / 範囲
 * 条件のみ: `id IN` / `pubkey IN` / `kind IN` / `created_at >= since` /
 * `created_at <= until`（since / until は truthy のときのみ —
 * `eventMatchesFilter` の `filter.since &&` と同じ挙動）。
 *
 * `filter.limit` は、SQL の結果がそのまま最終結果になる場合（タグ条件が無く
 * SQL 条件が最終判定と完全等価な場合）のみ SQL に押し込む。タグ条件がある
 * 場合は JS 判定で行が落ち得るため、SQL では LIMIT せず新しい順
 * （created_at DESC, id ASC）に並べるだけにし、呼び出し側が判定後に切り詰める。
 *
 * @param filter Filter conditions (must have passed {@link hasInvalidTagFilter})
 * @returns SQL and bind parameters
 */
export function buildFilterQuery(filter: Filter): BuiltFilterQuery {
  const { ids, authors, kinds, since, until, limit, ...rest } = filter;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

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
  // true。この場合 SQL に LIMIT を押し込むと取りこぼしが生じるため、呼び出し側の
  // JS 判定後の切り詰めに委ねる
  let narrowingIncomplete = hasTagFilter;

  const addInCondition = (column: string, values: (string | number)[]) => {
    // 空配列は条件を押し込まない（最終判定が「何にもマッチしない」を担うため、
    // LIMIT の安全性にも影響しない）
    if (values.length === 0) return;
    // 上限超過時も押し込まず、粗い候補を最終判定に委ねる
    if (values.length > MAX_IN_PARAMS) {
      narrowingIncomplete = true;
      return;
    }
    const placeholders = values.map(() => '?').join(', ');
    conditions.push(`${column} IN (${placeholders})`);
    params.push(...values);
  };

  if (tagValues.length > 0 && !ids?.length && !authors?.length && !kinds?.length) {
    // タグ主導の分岐: event_tags で絞る（Dexie の indexed_tags 分岐に対応）
    if (tagValues.length <= MAX_IN_PARAMS) {
      const placeholders = tagValues.map(() => '?').join(', ');
      conditions.push(`id IN (SELECT event_id FROM event_tags WHERE tag IN (${placeholders}))`);
      params.push(...tagValues);
    }
  } else {
    addInCondition('id', ids ?? []);
    addInCondition('pubkey', authors ?? []);
    addInCondition('kind', kinds ?? []);
  }

  if (since) {
    conditions.push('created_at >= ?');
    params.push(since);
  }
  if (until) {
    conditions.push('created_at <= ?');
    params.push(until);
  }

  let sql = 'SELECT * FROM events';
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  if (limit !== undefined) {
    // 切り詰めは「新しい順」（NIP-01 の limit セマンティクス / capEvents と同じ、
    // id は決定性のためのタイブレーク）
    sql += ' ORDER BY created_at DESC, id ASC';
    if (!narrowingIncomplete) {
      sql += ' LIMIT ?';
      params.push(Math.max(0, limit));
    }
  }

  return { sql, params };
}
