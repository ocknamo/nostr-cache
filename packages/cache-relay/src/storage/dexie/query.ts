/**
 * How a filter is answered from the Dexie events table.
 *
 * The whole read strategy lives here: which index a filter is put on, in which
 * order its rows are walked, when the walk can stop, and how NIP-01's `limit`
 * truncates the result. `DexieStorage` only hands over the table and the
 * transaction scope, so a change of strategy is a change to this module.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { Dexie } from 'dexie';
import {
  capEvents,
  eventMatchesFilter,
  normalizeLimit,
  rejectsEveryRow,
} from '../../utils/filter-utils.js';
import { type NostrEventTable, rowToEvent } from './schema.js';
import { getIndexedTagValues } from './tag-index.js';

/** Beyond this, one `created_at` walk beats a cursor per kind. */
const MAX_ORDERED_KINDS = 8;

/**
 * Beyond this, walking the kind beats a cursor per author: the sub-range seek is
 * the expensive part, which is why `[pubkey+kind]` with 500 of them takes 538ms
 * against 5ms for one descending walk.
 */
const MAX_ORDERED_AUTHOR_CURSORS = 16;

/**
 * Narrow the events table by the filter's time range on the `created_at` index.
 *
 * NIP-01 の `since` / `until` はどちらも境界を含む（`since <= created_at <= until`）。
 * Dexie の `between()` は既定で上限排他のため、両端を明示的に包含指定する。
 * 最終判定を行う {@link eventMatchesFilter} も包含なので、ここで境界のイベントを
 * 落とすと二段構えの絞り込みが不整合になり、そのイベントは復活しない。
 */
function betweenCreatedAt(
  table: Dexie.Table<NostrEventTable, string>,
  since: number | undefined,
  until: number | undefined
): Dexie.Collection<NostrEventTable, string> {
  // 開いた端が 0 だと `created_at` が負の行を落とすが、最終判定は `since` 未指定なら
  // 下限を課さないため復活できない
  return table
    .where('created_at')
    .between(since ?? Dexie.minKey, until ?? Dexie.maxKey, true, true);
}

/** The `indexed_tags` values a filter's tag conditions can be looked up by. */
function tagIndexValues(filter: Filter): string[] {
  const values: string[] = [];
  for (const [key, condition] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(condition) || condition.length === 0) {
      continue;
    }
    const tagName = key.slice(1);
    if (tagName.length !== 1 || !/^[a-zA-Z]$/.test(tagName)) {
      continue;
    }
    values.push(...getIndexedTagValues(tagName, condition as string[]));
  }
  return values;
}

/**
 * Build an optimized Dexie query for a single filter.
 *
 * Picks the most selective available index for the filter's combination of
 * `ids` / `authors` / `kinds` / time range / single-letter tag filters,
 * falling back to a full-table collection when nothing indexable is present.
 * The returned collection still needs {@link eventRowMatchesFilter} applied to
 * enforce the parts of the filter the index cannot express exactly.
 */
export function buildOptimizedQuery(
  table: Dexie.Table<NostrEventTable, string>,
  filter: Filter
): Dexie.Collection<NostrEventTable, string> {
  const { ids, authors, kinds, since, until } = filter;
  let collection: Dexie.Collection<NostrEventTable, string>;

  const indexedTagValues = tagIndexValues(filter);

  if (ids?.length) {
    collection = table.where('id').anyOf(ids);
  }
  // authors + kinds + 時間範囲の組み合わせ
  else if (authors?.length && kinds?.length && (since !== undefined || until !== undefined)) {
    collection = betweenCreatedAt(table, since, until);
    collection = collection.filter(
      (event) => authors.includes(event.pubkey) && kinds.includes(event.kind)
    );
  }
  // authors + 時間範囲の組み合わせ
  else if (authors?.length && (since !== undefined || until !== undefined)) {
    collection = betweenCreatedAt(table, since, until);
    collection = collection.filter((event) => authors.includes(event.pubkey));
  }
  // authors + kinds の組み合わせ。タグ条件より先に見る: 2 フィールドの等値
  // なので普通は「その人のその kind」まで絞れているうえ、アドレサブルの参照
  // （`{kinds:[k],authors:[p],'#d':[id]}`）がこの形で、`d` の値は
  // 人をまたいで衝突する（`d:"1"` など）
  else if (authors?.length && kinds?.length) {
    const combinations = authors.flatMap((author) => kinds.map((kind) => [author, kind]));
    collection = table.where('[pubkey+kind]').anyOf(combinations);
  }
  // タグ条件は単一フィールドの `kind` / `pubkey` / `created_at` より先に選ぶ。
  // 1 つのタグ値に一致する行は普通ごく少数だが、`kind` インデックスはその kind の
  // 全行を返す（`{kinds:[1],'#e':[…]}` ならキャッシュ内の全 kind 1）。
  //
  // `distinct()` は multiEntry の必然。複数の指定値に一致する行（root と parent の
  // 両方を `e` タグに持つ NIP-10 のリプライ）は同じ行が指定値の数だけ返るため、
  // これが無いと `limit` を重複が食う。
  //
  // 前提: `indexed_tags` は保存時に MAX_INDEXED_TAGS 件で切り詰められる
  // （`tag-index.ts`）。単一文字タグが 100 個を超えるイベントは、溢れたタグでは
  // 引けない。この経路を kinds 併用のフィルタにも広げたことで、その切り詰めが
  // 見える範囲も広がっている
  else if (indexedTagValues.length > 0) {
    collection = table.where('indexed_tags').anyOf(indexedTagValues).distinct();
  }
  // kinds + 時間範囲の組み合わせ
  else if (kinds?.length && (since !== undefined || until !== undefined)) {
    collection = betweenCreatedAt(table, since, until);
    collection = collection.filter((event) => kinds.includes(event.kind));
  }
  // 単一条件の場合
  else if (kinds?.length) {
    collection = table.where('kind').anyOf(kinds);
  } else if (authors?.length) {
    collection = table.where('pubkey').anyOf(authors);
  } else if (since !== undefined || until !== undefined) {
    collection = betweenCreatedAt(table, since, until);
  } else {
    collection = table.toCollection();
  }

  return collection;
}

/**
 * How a filter's rows are to be read.
 *
 * `newest` walks `created_at` descending — the order NIP-01 applies `limit` in —
 * so each cursor can stop once it has enough. `scan` must read every matching
 * row before the newest N is known, so it is also the only mode that can serve
 * a filter without a `limit`.
 *
 * Collections are single use: Dexie's `filter` / `until` mutate a collection's
 * context rather than deriving a new one, so a re-read carries the first read's
 * chain.
 */
export type QueryPlan =
  | {
      mode: 'newest';
      collections: Dexie.Collection<NostrEventTable, string>[];
      limit: number;
    }
  | {
      mode: 'scan';
      collection: Dexie.Collection<NostrEventTable, string>;
      limit: number | undefined;
    };

/** Descending range over one kind. Both ends inclusive, as in {@link betweenCreatedAt}. */
function newestOfKind(
  table: Dexie.Table<NostrEventTable, string>,
  kind: number,
  since: number | undefined,
  until: number | undefined
): Dexie.Collection<NostrEventTable, string> {
  return table
    .where('[kind+created_at]')
    .between([kind, since ?? Dexie.minKey], [kind, until ?? Dexie.maxKey], true, true)
    .reverse();
}

/** Descending range over one author's events, optionally of one kind. */
function newestOfAuthor(
  table: Dexie.Table<NostrEventTable, string>,
  pubkey: string,
  kind: number | undefined,
  since: number | undefined,
  until: number | undefined
): Dexie.Collection<NostrEventTable, string> {
  const low = since ?? Dexie.minKey;
  const high = until ?? Dexie.maxKey;
  return kind === undefined
    ? table
        .where('[pubkey+created_at]')
        .between([pubkey, low], [pubkey, high], true, true)
        .reverse()
    : table
        .where('[pubkey+kind+created_at]')
        .between([pubkey, kind, low], [pubkey, kind, high], true, true)
        .reverse();
}

/**
 * Plan how to read one filter's rows.
 *
 * The ordered mode exists for the follow timeline: `{kinds:[1],authors:[…500],
 * limit:50}` lands on `[pubkey+kind]` as 500 sub-ranges and reads every matching
 * row (574ms against a 5000-event cache), where walking the kind newest-first and
 * cutting off at 50 answers the same filter in 36ms.
 *
 * When the kind is walked, `authors` is checked per row by
 * {@link eventRowMatchesFilter} — which is what makes it a stopping condition rather
 * than a post-filter, since only rows that pass count towards `limit`. The cost
 * is then in rows *walked* rather than rows *matched*, so a wide but sparse
 * author set walks the whole kind (145ms worst case, bounded by
 * `storageMaxSize`). No scan budget is imposed for it.
 */
export function planQuery(table: Dexie.Table<NostrEventTable, string>, filter: Filter): QueryPlan {
  const limit = normalizeLimit(filter.limit);
  const scan = (): QueryPlan => ({
    mode: 'scan',
    collection: buildOptimizedQuery(table, filter),
    limit,
  });

  // limit なしでは打ち切る根拠が無く、limit 0 は readNewest が境界を置けないため
  // 降順に開いても走査が止まらない
  if (limit === undefined || limit <= 0) {
    return scan();
  }
  // 主キー参照は必要な行しか読まず、タグ値に一致する行も普通ごく少数。
  // `indexed_tags` はそもそも created_at 順に並べられない
  if (filter.ids !== undefined || tagIndexValues(filter).length > 0) {
    return scan();
  }

  const { authors, kinds, since, until } = filter;
  // 同じ範囲に 2 本開くと同じ行が 2 回届き、`capEvents` が limit を重複で食う
  const distinctKinds = kinds?.length ? [...new Set(kinds)] : [];
  const distinctAuthors = authors?.length ? [...new Set(authors)] : [];

  // 著者ごとに開けばその人の行しか読まない。kind 走査に落とすと、単著者
  // タイムライン（`parseFilter` が必ず limit を入れる）が 8ms から 128ms になる
  const authorCursors = distinctAuthors.length * Math.max(distinctKinds.length, 1);
  if (distinctAuthors.length && authorCursors <= MAX_ORDERED_AUTHOR_CURSORS) {
    const collections = distinctKinds.length
      ? distinctAuthors.flatMap((pubkey) =>
          distinctKinds.map((kind) => newestOfAuthor(table, pubkey, kind, since, until))
        )
      : distinctAuthors.map((pubkey) => newestOfAuthor(table, pubkey, undefined, since, until));
    return { mode: 'newest', collections, limit };
  }

  if (distinctKinds.length && distinctKinds.length <= MAX_ORDERED_KINDS) {
    return {
      mode: 'newest',
      collections: distinctKinds.map((kind) => newestOfKind(table, kind, since, until)),
      limit,
    };
  }

  return {
    mode: 'newest',
    collections: [betweenCreatedAt(table, since, until).reverse()],
    limit,
  };
}

/**
 * Final per-row validation applied while the query's rows are read: the
 * conditions the index cannot express.
 *
 * Runs on every row a descending plan *walks*, so it does not re-check
 * {@link rejectsEveryRow} — `queryEvents` has already rejected such filters
 * whole.
 */
export function eventRowMatchesFilter(row: NostrEventTable, filter: Filter): boolean {
  return eventMatchesFilter(rowToEvent(row), filter);
}

/**
 * Read the newest `limit` matching rows from a descending collection, plus
 * everything tied with the last of them.
 *
 * The ties are why this is not `collection.filter(…).limit(limit)`: a descending
 * walk puts equal timestamps in *descending primary key* order, while NIP-01
 * breaks such a tie by the **lowest** id, so stopping at exactly `limit` rows can
 * drop the row that should have been kept.
 *
 * Exported for its own test — the chain order below only costs speed when it is
 * wrong, which no assertion about the returned rows can see.
 *
 * @param collection Must come from a {@link planQuery} plan in `newest` mode
 * @param matches The filter's row predicate
 */
export async function readNewest(
  collection: Dexie.Collection<NostrEventTable, string>,
  matches: (row: NostrEventTable) => boolean,
  limit: number
): Promise<NostrEventTable[]> {
  const rows: NostrEventTable[] = [];
  /** `created_at` of the `limit`-th match; rows older than it are surplus. */
  let boundary: number | undefined;

  await collection
    // `filter` より先に積む。Dexie の鎖は短絡評価なので、逆順だと一致しない行で
    // 打ち切り判定が評価されず、次の一致行まで走査が伸びる
    .until((row) => boundary !== undefined && row.created_at < boundary)
    .filter(matches)
    .each((row) => {
      rows.push(row);
      if (rows.length === limit) {
        boundary = row.created_at;
      }
    });

  return rows;
}

/**
 * Answer one filter: plan it, read its rows, and truncate to NIP-01's `limit`.
 *
 * The truncation is always `capEvents` — Dexie's `Collection.limit()` takes the
 * first N in *index* order, while NIP-01 asks for the newest N in descending
 * order (the rule `SqliteStorage` and `maxEventsPerRequest` also follow).
 *
 * @param db The database owning `table`, for the read transaction a multi-cursor
 *   plan needs
 */
export async function queryEvents(
  db: Dexie,
  table: Dexie.Table<NostrEventTable, string>,
  filter: Filter
): Promise<NostrEvent[]> {
  // 降順プランは満たされない `limit` を埋めようと範囲全体を走査してしまうため、
  // 行ごとの判定に混ぜず先に弾く
  if (rejectsEveryRow(filter)) {
    return [];
  }

  const matches = (row: NostrEventTable) => eventRowMatchesFilter(row, filter);
  const plan = planQuery(table, filter);

  if (plan.mode === 'newest') {
    // カーソルの間に書き込みが挟まると、1 つのフィルタの答えが別々の
    // スナップショットから組み上がってしまう
    const rows = await db.transaction('r', table, async () =>
      (
        await Promise.all(
          plan.collections.map((collection) => readNewest(collection, matches, plan.limit))
        )
      ).flat()
    );
    return capEvents(rows.map(rowToEvent), plan.limit);
  }

  const events = (await plan.collection.filter(matches).toArray()).map(rowToEvent);
  return plan.limit !== undefined ? capEvents(events, plan.limit) : events;
}
