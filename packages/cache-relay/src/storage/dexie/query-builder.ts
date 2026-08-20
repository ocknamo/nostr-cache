import type { Filter } from '@nostr-cache/shared';
import { Dexie } from 'dexie';
import { compileFilterMatcher } from '../../utils/filter-utils.js';
import type { NostrEventTable } from './schema.js';
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
 * 最終判定を行う {@link compileFilterMatcher} も包含なので、ここで境界のイベントを
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
 * How a filter's rows are to be read: an ordered plan walks `created_at`
 * descending — the order NIP-01 applies `limit` in — so the caller can stop the
 * cursor once it has enough. An unordered one must read every matching row
 * before the newest N is known.
 */
export interface QueryPlan {
  /**
   * Single use only: Dexie's `filter` / `until` mutate a collection's context
   * rather than deriving a new one, so a re-read carries the first read's chain.
   */
  collections: Dexie.Collection<NostrEventTable, string>[];
  ordered: boolean;
}

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
 * When the kind is walked, `authors` is checked per row by the caller's
 * {@link compileRowMatcher} — which is what makes it a stopping condition rather
 * than a post-filter, since only rows that pass count towards `limit`. The cost
 * is then in rows *walked* rather than rows *matched*, so a wide but sparse
 * author set walks the whole kind (145ms worst case, bounded by
 * `storageMaxSize`). No scan budget is imposed for it.
 *
 * @param limit Already through `normalizeLimit`; without one nothing can stop
 *   the walk, so the plan is unordered.
 */
export function planQuery(
  table: Dexie.Table<NostrEventTable, string>,
  filter: Filter,
  limit: number | undefined
): QueryPlan {
  const unordered = (): QueryPlan => ({
    collections: [buildOptimizedQuery(table, filter)],
    ordered: false,
  });

  if (limit === undefined || limit <= 0) {
    return unordered();
  }
  // 主キー参照は必要な行しか読まず、タグ値に一致する行も普通ごく少数。
  // `indexed_tags` はそもそも created_at 順に並べられない
  if (filter.ids !== undefined || tagIndexValues(filter).length > 0) {
    return unordered();
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
    return { collections, ordered: true };
  }

  if (distinctKinds.length && distinctKinds.length <= MAX_ORDERED_KINDS) {
    return {
      collections: distinctKinds.map((kind) => newestOfKind(table, kind, since, until)),
      ordered: true,
    };
  }

  return { collections: [betweenCreatedAt(table, since, until).reverse()], ordered: true };
}

/**
 * The final per-row validation for one filter: the conditions the index cannot
 * express, plus the malformed tag filters no row can satisfy.
 *
 * Rows are matched as they are, without projecting to {@link NostrEvent} first —
 * an ordered plan runs this on every row it walks, not only on matching ones.
 */
export function compileRowMatcher(filter: Filter): (row: NostrEventTable) => boolean {
  if (rejectsEveryRow(filter)) {
    return () => false;
  }

  return compileFilterMatcher(filter);
}

/**
 * Whether a filter's tag conditions are ones no stored row can satisfy: a `#x`
 * key whose name is not a single letter, or whose values are not all non-empty
 * strings.
 *
 * Asked before the query, not only inside the row predicate: a descending plan
 * would otherwise walk its whole range to fill a `limit` that never can be.
 */
export function rejectsEveryRow(filter: Filter): boolean {
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) {
      continue;
    }
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

/** One-shot {@link compileRowMatcher}. */
export function eventRowMatchesFilter(row: NostrEventTable, filter: Filter): boolean {
  return compileRowMatcher(filter)(row);
}
