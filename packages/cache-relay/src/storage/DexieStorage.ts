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
  content: string;
  sig: string;
}

/**
 * DexieStorage class implements StorageAdapter using Dexie.js
 */
export class DexieStorage extends Dexie implements StorageAdapter {
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
        *tags,
        [pubkey+kind],
        [kind+created_at]
      `,
    });
  }

  /**
   * Save a Nostr event to storage
   *
   * @param event Event to save
   * @returns Promise resolving to true if successful
   */
  async saveEvent(event: NostrEvent): Promise<boolean> {
    try {
      await this.events.put({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
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
   * Build an optimized query based on filter conditions
   * @param filter Filter conditions
   * @returns Dexie.Collection
   */
  private buildOptimizedQuery(filter: Filter): Dexie.Collection<NostrEventTable, string> {
    const { ids, authors, kinds, since, until } = filter;
    let collection: Dexie.Collection<NostrEventTable, string>;

    // Use specific index based on filter combination
    if (ids?.length) {
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

          // Apply tag filters after index-based filtering
          for (const [key, values] of Object.entries(filter)) {
            if (key.startsWith('#') && values?.length) {
              const tagName = key.slice(1);
              collection = collection.filter((event) => {
                return event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]));
              });
            }
          }

          // Apply limit before converting to array
          if (filter.limit !== undefined) {
            collection = collection.limit(filter.limit);
          }

          return await collection.toArray();
        })
      );

      // Combine and deduplicate results
      return Array.from(new Map(eventSets.flat().map((event) => [event.id, event])).values());
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
