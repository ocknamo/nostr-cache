import { Filter, NostrEvent } from '@nostr-cache/types';
import Dexie from 'dexie';
import { StorageAdapter } from './StorageAdapter';

/**
 * NostrEvent table schema
 */
interface NostrEventTable {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  indexed_tags: string[]; // インデックス化されたタグ
  content: string;
  sig: string;
}

/**
 * DexieStorage class implements StorageAdapter using Dexie.js
 */
export class DexieStorage extends Dexie implements StorageAdapter {
  private static readonly MAX_INDEXED_TAGS = 100;
  private static readonly PRIORITY_TAGS = new Set(['e', 'p', 'a', 't', 'd', 'h', 'm', 'q', 'r']);
  private events!: Dexie.Table<NostrEventTable, string>;

  constructor(dbName = 'NostrCacheRelay') {
    super(dbName);

    // Define database schema with improved index definitions
    this.version(1).stores({
      events: `
        id,
        pubkey,
        created_at,
        kind,
        *indexed_tags,
        [pubkey+kind],
        [kind+created_at]
      `,
    });
  }

  /**
   * Format a tag for indexing if it's a single-letter tag
   * @param tag Tag array [key, value, ...]
   * @returns Formatted tag string or null if not indexable
   */
  private formatTagForIndex(tag: string[]): string | null {
    const [key, value] = tag;
    if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
      return `${key}:${value}`;
    }
    return null;
  }

  /**
   * Sort indexed tags by priority
   * @param tags Array of formatted tag strings
   * @returns Sorted array of tag strings
   */
  private sortIndexedTags(tags: string[]): string[] {
    return tags.sort((a, b) => {
      const aKey = a.charAt(0);
      const bKey = b.charAt(0);
      const aIsPriority = DexieStorage.PRIORITY_TAGS.has(aKey);
      const bIsPriority = DexieStorage.PRIORITY_TAGS.has(bKey);
      if (aIsPriority && !bIsPriority) return -1;
      if (!aIsPriority && bIsPriority) return 1;
      return 0;
    });
  }

  /**
   * Get indexed tags from event tags
   * @param tags Event tags
   * @returns Array of indexed tag strings
   */
  private getIndexedTags(tags: string[][] = []): string[] {
    const formattedTags = (tags || [])
      .map((tag) => this.formatTagForIndex(tag))
      .filter((tag): tag is string => tag !== null);

    // ソートが必要な場合のみ実行
    if (formattedTags.length > DexieStorage.MAX_INDEXED_TAGS) {
      return this.sortIndexedTags(formattedTags).slice(0, DexieStorage.MAX_INDEXED_TAGS);
    }

    return formattedTags;
  }

  async saveEvent(event: NostrEvent): Promise<boolean> {
    try {
      await this.events.put({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        indexed_tags: this.getIndexedTags(event.tags),
        content: event.content,
        sig: event.sig,
      });
      return true;
    } catch (error) {
      console.error('Failed to save event:', error);
      return false;
    }
  }

  /**
   * Get indexed tag values for a single-letter tag
   * @param tagName Tag name
   * @param values Tag values
   * @returns Array of indexed tag strings
   */
  private getIndexedTagValues(tagName: string, values: string[]): string[] {
    if (tagName.length === 1 && /^[a-zA-Z]$/.test(tagName)) {
      return values.map((value) => `${tagName}:${value}`);
    }
    return [];
  }

  /**
   * Build an optimized query based on filter conditions
   * @param filter Filter conditions
   * @returns Dexie.Collection
   */
  private buildOptimizedQuery(filter: Filter): Dexie.Collection<NostrEventTable, string> {
    const { ids, authors, kinds, since, until, ...tagFilters } = filter;
    let collection: Dexie.Collection<NostrEventTable, string>;

    // Extract single-letter tag filters
    const indexedTagValues: string[] = [];
    for (const [key, values] of Object.entries(tagFilters)) {
      if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
        const tagName = key.slice(1);
        const indexedValues = this.getIndexedTagValues(tagName, values as string[]);
        if (indexedValues.length > 0) {
          indexedTagValues.push(...indexedValues);
        }
      }
    }

    // Use indexed_tags if available and no other primary filters
    if (indexedTagValues.length > 0 && !ids?.length && !authors?.length && !kinds?.length) {
      collection = this.events.where('indexed_tags').anyOf(indexedTagValues);
    }
    // Use specific index based on filter combination
    else if (ids?.length) {
      // Use primary key index for id lookups
      collection = this.events.where('id').anyOf(ids);
    } else if (authors?.length && kinds?.length) {
      // Use compound index for author+kind combinations
      const combinations = authors.flatMap((author) => kinds.map((kind) => [author, kind]));
      collection = this.events.where('[pubkey+kind]').anyOf(combinations);
    } else if (kinds?.length) {
      if (since !== undefined || until !== undefined) {
        // Use compound index for kind+time range
        collection = this.events
          .where('[kind+created_at]')
          .between([kinds[0], since || 0], [kinds[0], until || Infinity], true, true);
        // Filter additional kinds if multiple kinds specified
        if (kinds.length > 1) {
          collection = collection.filter((event) => kinds.includes(event.kind));
        }
      } else {
        // Use kind index
        collection = this.events.where('kind').anyOf(kinds);
      }
    } else if (authors?.length) {
      // Use pubkey index
      collection = this.events.where('pubkey').anyOf(authors);
    } else {
      // Fallback to time range if no other filters
      if (since !== undefined || until !== undefined) {
        collection = this.events.where('created_at').between(since || 0, until || Infinity);
      } else {
        // Last resort: full collection
        collection = this.events.toCollection();
      }
    }

    return collection;
  }

  /**
   * Get events matching the given filters
   *
   * @param filters Array of filters to match events against
   * @returns Promise resolving to array of matching events
   */
  async getEvents(filters: Filter[]): Promise<NostrEvent[]> {
    try {
      // Process each filter independently and combine results
      const eventSets = await Promise.all(
        filters.map(async (filter) => {
          let collection = this.buildOptimizedQuery(filter);

          // Apply tag filters using indexed_tags when possible
          for (const [key, values] of Object.entries(filter)) {
            if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
              const tagName = key.slice(1);
              if (tagName.length === 1 && /^[a-zA-Z]$/.test(tagName)) {
                // Use indexed_tags for single-letter tags
                const indexedValues = (values as string[]).map((value) => `${tagName}:${value}`);
                collection = collection.filter((event) =>
                  indexedValues.some((indexedValue: string) =>
                    event.indexed_tags.includes(indexedValue)
                  )
                );
              } else {
                // Fallback to regular tag filtering for non-single-letter tags
                collection = collection.filter((event) => {
                  return event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]));
                });
              }
            }
          }

          // Apply limit before converting to array
          if (filter.limit !== undefined) {
            collection = collection.limit(filter.limit);
          }

          return await collection.toArray();
        })
      );

      // Convert NostrEventTable to NostrEvent and deduplicate results
      return Array.from(
        new Map(
          eventSets.flat().map((event) => [
            event.id,
            {
              id: event.id,
              pubkey: event.pubkey,
              created_at: event.created_at,
              kind: event.kind,
              tags: event.tags,
              content: event.content,
              sig: event.sig,
            } as NostrEvent,
          ])
        ).values()
      );
    } catch (error) {
      console.error('Failed to get events:', error);
      return [];
    }
  }

  /**
   * Delete an event from storage
   *
   * @param id ID of the event to delete
   * @returns Promise resolving to true if successful
   */
  async deleteEvent(id: string): Promise<boolean> {
    try {
      const count = await this.events.where('id').equals(id).delete();
      return count > 0;
    } catch (error) {
      console.error('Failed to delete event:', error);
      return false;
    }
  }

  /**
   * Clear all events from storage
   */
  async clear(): Promise<void> {
    try {
      await this.events.clear();
    } catch (error) {
      console.error('Failed to clear events:', error);
    }
  }
}
