import type { Filter } from '@nostr-cache/shared';
import type { Dexie } from 'dexie';
import { eventMatchesFilter } from '../../utils/filter-utils.js';
import { type NostrEventTable, rowToEvent } from './schema.js';
import { getIndexedTagValues } from './tag-index.js';

/**
 * Build an optimized Dexie query for a single filter.
 *
 * Picks the most selective available index for the filter's combination of
 * `ids` / `authors` / `kinds` / time range / single-letter tag filters,
 * falling back to a full-table collection when nothing indexable is present.
 * The returned collection still needs {@link eventRowMatchesFilter} applied to
 * enforce the parts of the filter the index cannot express exactly.
 *
 * @param table The Dexie events table
 * @param filter Filter conditions
 * @returns A Dexie collection narrowed by the chosen index
 */
export function buildOptimizedQuery(
  table: Dexie.Table<NostrEventTable, string>,
  filter: Filter
): Dexie.Collection<NostrEventTable, string> {
  const { ids, authors, kinds, since, until, ...tagFilters } = filter;
  let collection: Dexie.Collection<NostrEventTable, string>;

  // Extract single-letter tag filters
  const indexedTagValues: string[] = [];
  for (const [key, values] of Object.entries(tagFilters)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      const tagName = key.slice(1);
      // タグ名が単一のアルファベットであることを確認
      if (tagName.length === 1 && /^[a-zA-Z]$/.test(tagName)) {
        const indexedValues = getIndexedTagValues(tagName, values as string[]);
        if (indexedValues.length > 0) {
          indexedTagValues.push(...indexedValues);
        }
      }
    }
  }

  // Use indexed_tags if available and no other primary filters
  if (indexedTagValues.length > 0 && !ids?.length && !authors?.length && !kinds?.length) {
    collection = table.where('indexed_tags').anyOf(indexedTagValues);
  }
  // Use specific index based on filter combination
  else if (ids?.length) {
    // Use primary key index for id lookups
    collection = table.where('id').anyOf(ids);
  }
  // authors + kinds + 時間範囲の組み合わせ
  else if (authors?.length && kinds?.length && (since !== undefined || until !== undefined)) {
    const timeRange = [since || 0, until || Number.POSITIVE_INFINITY];
    // 時間範囲でフィルタリング
    collection = table.where('created_at').between(timeRange[0], timeRange[1]);
    // authorsとkindsでフィルタリング
    collection = collection.filter(
      (event) => authors.includes(event.pubkey) && kinds.includes(event.kind)
    );
  }
  // authors + 時間範囲の組み合わせ
  else if (authors?.length && (since !== undefined || until !== undefined)) {
    // 時間範囲でフィルタリング
    collection = table.where('created_at').between(since || 0, until || Number.POSITIVE_INFINITY);
    // authorsでフィルタリング
    collection = collection.filter((event) => authors.includes(event.pubkey));
  }
  // authors + kinds の組み合わせ
  else if (authors?.length && kinds?.length) {
    // Use compound index for author+kind combinations
    const combinations = authors.flatMap((author) => kinds.map((kind) => [author, kind]));
    collection = table.where('[pubkey+kind]').anyOf(combinations);
  }
  // kinds + 時間範囲の組み合わせ
  else if (kinds?.length && (since !== undefined || until !== undefined)) {
    // 時間範囲でフィルタリング
    collection = table.where('created_at').between(since || 0, until || Number.POSITIVE_INFINITY);
    // kindsでフィルタリング
    collection = collection.filter((event) => kinds.includes(event.kind));
  }
  // 単一条件の場合
  else if (kinds?.length) {
    collection = table.where('kind').anyOf(kinds);
  } else if (authors?.length) {
    collection = table.where('pubkey').anyOf(authors);
  } else if (since !== undefined || until !== undefined) {
    // untilは指定された時刻を含むように+1する
    const timeRange = [
      since || 0,
      (until || Number.POSITIVE_INFINITY) + (until === Number.POSITIVE_INFINITY ? 0 : 1),
    ];
    collection = table.where('created_at').between(timeRange[0], timeRange[1], true, false);
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
 *
 * @param row Stored table row
 * @param filter Filter to validate the row against
 * @returns Whether the row matches the filter
 */
export function eventRowMatchesFilter(row: NostrEventTable, filter: Filter): boolean {
  // タグフィルターの追加検証
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#')) {
      const tagName = key.slice(1);
      // タグ名が無効な場合は結果に含めない
      if (tagName.length !== 1 || !/^[a-zA-Z]$/.test(tagName)) {
        return false;
      }
      // タグ値が無効な場合は結果に含めない
      if (!Array.isArray(values) || values.some((v) => !v || typeof v !== 'string')) {
        return false;
      }
    }
  }

  return eventMatchesFilter(rowToEvent(row), filter);
}
