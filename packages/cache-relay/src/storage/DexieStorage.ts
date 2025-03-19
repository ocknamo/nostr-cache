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
          let collection = this.events.toCollection();

          // Apply basic filters
          const { ids, authors, kinds } = filter;
          if (ids?.length) {
            collection = collection.filter((event) => ids.includes(event.id));
          }
          if (authors?.length) {
            collection = collection.filter((event) => authors.includes(event.pubkey));
          }
          if (kinds?.length) {
            collection = collection.filter((event) => kinds.includes(event.kind));
          }

          // Apply tag filters
          for (const [key, values] of Object.entries(filter)) {
            if (key.startsWith('#') && values?.length) {
              const tagName = key.slice(1); // Remove '#' prefix
              collection = collection.filter((event) => {
                return event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]));
              });
            }
          }

          // Apply time range filters
          const { since, until } = filter;
          if (since !== undefined) {
            collection = collection.filter((event) => event.created_at >= since);
          }
          if (until !== undefined) {
            collection = collection.filter((event) => event.created_at <= until);
          }

          // Apply limit at the end
          const results = await collection.toArray();
          return filter.limit !== undefined ? results.slice(0, filter.limit) : results;
        })
      );

      // Combine and deduplicate results
      const allEvents = eventSets.flat();
      const uniqueEvents = Array.from(
        new Map(allEvents.map((event) => [event.id, event])).values()
      );

      return uniqueEvents;
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
