/**
 * Tag indexing helpers for the Dexie storage adapter.
 *
 * Nostr single-letter tags (`e`, `p`, `a`, …) are flattened into
 * `"<key>:<value>"` strings and stored in the multi-entry `indexed_tags`
 * index so tag filters (`#e`, `#p`, …) can be served by an index lookup.
 */

const MAX_INDEXED_TAGS = 100;
const PRIORITY_TAGS = new Set(['e', 'p', 'a', 't', 'd', 'h', 'm', 'q', 'r']);

export function formatTagForIndex(tag: string[]): string | null {
  if (tag.length < 2) return null;
  const [key, value] = tag;
  if (!key || !value) return null;
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
    return `${key}:${value}`;
  }
  return null;
}

export function sortIndexedTags(tags: string[]): string[] {
  return tags.sort((a, b) => {
    const aKey = a.charAt(0);
    const bKey = b.charAt(0);
    const aIsPriority = PRIORITY_TAGS.has(aKey);
    const bIsPriority = PRIORITY_TAGS.has(bKey);
    if (aIsPriority && !bIsPriority) return -1;
    if (!aIsPriority && bIsPriority) return 1;
    return 0;
  });
}

export function getIndexedTags(tags: string[][] = []): string[] {
  const formattedTags = (tags || [])
    .map((tag) => formatTagForIndex(tag))
    .filter((tag): tag is string => tag !== null);

  if (formattedTags.length > MAX_INDEXED_TAGS) {
    return sortIndexedTags(formattedTags).slice(0, MAX_INDEXED_TAGS);
  }

  return formattedTags;
}

export function getIndexedTagValues(tagName: string, values: string[]): string[] {
  if (tagName.length === 1 && /^[a-zA-Z]$/.test(tagName)) {
    return values
      .filter((value) => value && typeof value === 'string')
      .map((value) => `${tagName}:${value}`);
  }
  return [];
}
