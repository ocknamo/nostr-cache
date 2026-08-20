import type { Filter } from '@nostr-cache/shared';
import { Dexie } from 'dexie';
import { compileFilterMatcher } from '../../utils/filter-utils.js';
import type { NostrEventTable } from './schema.js';
import { getIndexedTagValues } from './tag-index.js';

/**
 * Kinds a `limit` query is still willing to walk as separate descending scans.
 *
 * Each kind costs its own cursor, and every one of them reads up to `limit`
 * rows, so a filter naming a long list of kinds is cheaper to answer from the
 * plain `created_at` index in one pass.
 */
const MAX_ORDERED_KINDS = 8;

/**
 * Author-keyed descending cursors a `limit` query is willing to open.
 *
 * Opening a cursor per author is what makes a *narrow* author set fast: it reads
 * only that person's newest rows instead of walking the kind looking for them.
 * It stops paying off in bulk, though — the sub-range seek is the expensive part
 * of a per-author plan, which is exactly why `[pubkey+kind]` with 500 of them
 * takes 538ms where one descending walk takes 5ms. So a set this size or smaller
 * gets its own cursors and anything larger walks the kind.
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
  // 開いた端は `Dexie.minKey` / `maxKey`。0 を下端にすると `created_at` が負の行を
  // 落とすが、最終判定の側は `since` 未指定なら下限を課さないので、その行は
  // 復活できない。`[kind+created_at]` を使う分岐と端の扱いをそろえる意味もある
  return table
    .where('created_at')
    .between(since ?? Dexie.minKey, until ?? Dexie.maxKey, true, true);
}

/**
 * The `indexed_tags` values a filter's single-letter tag conditions can be
 * looked up by, empty when it has none the index can answer.
 */
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
 * `ordered` is the whole point of the two modes. An ordered plan hands back
 * collections that already walk `created_at` **descending**, which is the order
 * NIP-01 wants `limit` applied in — so the caller can stop the cursor once it
 * has enough and never look at the rest. An unordered plan is the classic
 * "narrow by the most selective index, then sort what came back", where every
 * matching row has to be read before the newest N can be known.
 */
export interface QueryPlan {
  /**
   * Collections to read, one per cursor the plan opens.
   *
   * Single use only: Dexie's `filter` / `until` mutate a collection's context
   * rather than deriving a new one, so a plan that is kept and read twice would
   * carry the first read's chain into the second.
   */
  collections: Dexie.Collection<NostrEventTable, string>[];
  /** Whether the rows arrive newest-first, so `limit` can stop the walk. */
  ordered: boolean;
}

/**
 * Descending range over one kind, on the `[kind+created_at]` index.
 *
 * Both ends are inclusive for the same reason as {@link betweenCreatedAt}, and
 * the open end of the range is `Dexie.minKey` / `maxKey` rather than a number:
 * this is a compound key, and those sort below and above every real value.
 */
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

/**
 * Descending range over one author's events, optionally of one kind.
 *
 * Reads nothing but that person's rows, which is what a narrow `authors` needs:
 * walking the kind instead would read everyone else's rows looking for theirs.
 */
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
 * The ordered mode exists for the follow timeline. `{kinds:[1],authors:[…500],
 * limit:50}` has no time range, so {@link buildOptimizedQuery} puts it on
 * `[pubkey+kind]` as 500 sub-ranges and reads *every* matching row — `getEvents`
 * measured at 574ms against a 5000-event cache with 4000 of them matching,
 * against 36ms for the same answer read newest-first and cut off at 50.
 *
 * Which descending cursors to open depends on how many the filter implies:
 *
 * - A narrow `authors` (up to {@link MAX_ORDERED_AUTHOR_CURSORS} cursors) gets
 *   one per author, so the walk stays inside their own rows.
 * - Otherwise a narrow `kinds` (up to {@link MAX_ORDERED_KINDS}) gets one per
 *   kind, and `authors` — 500 of them, for a follow timeline — is checked per
 *   row as the cursor advances (by {@link compileRowMatcher}, exactly as the
 *   unordered plans already do). That is what turns it from a post-filter into a
 *   stopping condition: only rows that pass count towards `limit`.
 * - Failing both, `created_at` itself is walked.
 *
 * The trade-off in the kind-walking shape is the mirror image of the old plan's.
 * An unordered plan reads as many rows as *match*; this one reads as many as it
 * *walks* — so an author set that is wide but matches sparsely walks the kind's
 * whole range. That worst case measured 145ms against the 5000-event cache, and
 * `storageMaxSize` bounds it, which is why no scan budget is imposed. The band
 * where this is genuinely a worse bet than the old plan is an author set too
 * wide for its own cursors but too sparse to fill `limit` early; both cost tens
 * of milliseconds there, so the cut-off is not tuned for it.
 *
 * @param limit The filter's `limit`, already through `normalizeLimit`. Without
 *   one there is nothing to stop at, so the plan is always unordered.
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
  // A primary-key lookup already reads only the rows asked for, and a tag value
  // normally matches a handful of rows — neither has a cheaper descending form,
  // and `indexed_tags` cannot be walked in `created_at` order at all.
  if (filter.ids !== undefined || tagIndexValues(filter).length > 0) {
    return unordered();
  }

  const { authors, kinds, since, until } = filter;
  // De-duplicated before they are counted as well as before they are walked: two
  // cursors over the same range would deliver every one of its rows twice, and
  // `capEvents` would count the copies against `limit`.
  const distinctKinds = kinds?.length ? [...new Set(kinds)] : [];
  const distinctAuthors = authors?.length ? [...new Set(authors)] : [];

  // A narrow author set is read per author, so the walk never leaves their rows.
  // Without this a single-author timeline — which `parseFilter` always gives a
  // `limit` — would walk the whole kind to find that one person's posts:
  // measured at 128ms against 8ms for the same filter on `[pubkey+kind]`.
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
 * Build the final per-row validation for one filter, doing the per-filter work
 * once.
 *
 * Rejects every row for malformed tag filters (a `#x` key whose name is not a
 * single letter, or whose values are not all non-empty strings) and otherwise
 * defers to the shared {@link compileFilterMatcher}. This reproduces the exact
 * conditions the index cannot express.
 *
 * Rows are matched as they are — a stored row carries every {@link NostrEvent}
 * field, so there is nothing to project first, and an ordered plan tests this
 * against every row it walks rather than only the matching ones.
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
 * Worth asking before the query rather than only inside the row predicate. A
 * descending plan would otherwise walk its whole range without ever filling
 * `limit` — for an answer that was known to be empty before the first row was
 * read.
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
