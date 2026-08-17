import type { Filter } from '@nostr-cache/shared';
import type { Dexie } from 'dexie';
import { eventMatchesFilter } from '../../utils/filter-utils.js';
import { type NostrEventTable, rowToEvent } from './schema.js';
import { getIndexedTagValues } from './tag-index.js';

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
  return table
    .where('created_at')
    .between(since ?? 0, until ?? Number.POSITIVE_INFINITY, true, true);
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
  const { ids, authors, kinds, since, until, ...tagFilters } = filter;
  let collection: Dexie.Collection<NostrEventTable, string>;

  const indexedTagValues: string[] = [];
  for (const [key, values] of Object.entries(tagFilters)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      const tagName = key.slice(1);
      if (tagName.length === 1 && /^[a-zA-Z]$/.test(tagName)) {
        const indexedValues = getIndexedTagValues(tagName, values as string[]);
        if (indexedValues.length > 0) {
          indexedTagValues.push(...indexedValues);
        }
      }
    }
  }

  if (ids?.length) {
    collection = table.where('id').anyOf(ids);
  }
  // タグ条件は kinds / authors より先に選ぶ。1つのタグ値に一致する行は普通ごく
  // 少数で、`kind` インデックスはその kind の全行を返すため（`{kinds:[1],'#e':[…]}`
  // ならキャッシュ内の全 kind 1）。`distinct()` は multiEntry の必然で、複数の
  // 指定値に一致する行（root と parent の両方を `e` タグに持つリプライなど）が
  // 重複して返るのを防ぐ。
  //
  // 前提: `indexed_tags` は保存時に MAX_INDEXED_TAGS 件で切り詰められる
  // （`tag-index.ts`）。単一文字タグが 100 個を超えるイベントは、溢れたタグでは
  // 引けない。この経路を kinds 併用のフィルタにも広げたことで、その切り詰めが
  // 見える範囲も広がっている
  else if (indexedTagValues.length > 0) {
    collection = table.where('indexed_tags').anyOf(indexedTagValues).distinct();
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
  // authors + kinds の組み合わせ
  else if (authors?.length && kinds?.length) {
    const combinations = authors.flatMap((author) => kinds.map((kind) => [author, kind]));
    collection = table.where('[pubkey+kind]').anyOf(combinations);
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
 * Final per-row validation applied after the index query.
 *
 * Rejects rows for malformed tag filters (a `#x` key whose name is not a
 * single letter, or whose values are not all non-empty strings) and otherwise
 * defers to the shared {@link eventMatchesFilter}. This reproduces the exact
 * conditions the index cannot express.
 */
export function eventRowMatchesFilter(row: NostrEventTable, filter: Filter): boolean {
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#')) {
      const tagName = key.slice(1);
      if (tagName.length !== 1 || !/^[a-zA-Z]$/.test(tagName)) {
        return false;
      }
      if (!Array.isArray(values) || values.some((v) => !v || typeof v !== 'string')) {
        return false;
      }
    }
  }

  return eventMatchesFilter(rowToEvent(row), filter);
}
