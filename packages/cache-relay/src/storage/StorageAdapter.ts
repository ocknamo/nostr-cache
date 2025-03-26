/**
 * Storage adapter interface for Nostr Cache Relay
 */

import type { Filter, NostrEvent } from '@nostr-cache/types';

/**
 * Storage adapter interface
 * Defines the contract for storage implementations
 */
export interface StorageAdapter {
  /**
   * Save an event to storage
   *
   * @param event Nostr event to save
   * @returns Promise resolving to true if successful, false otherwise
   */
  saveEvent(event: NostrEvent): Promise<boolean>;

  /**
   * Get events matching the given filters
   *
   * @param filters Array of filters to match events against
   * @returns Promise resolving to array of matching events
   */
  getEvents(filters: Filter[]): Promise<NostrEvent[]>;

  /**
   * Delete an event from storage
   *
   * @param id ID of the event to delete
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEvent(id: string): Promise<boolean>;

  /**
   * Clear all events from storage
   *
   * @returns Promise resolving when operation is complete
   */
  clear(): Promise<void>;

  /**
   * Delete events with the same pubkey and kind
   * Used for handling replaceable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean>;

  /**
   * Delete events with the same pubkey, kind, and d tag value
   * Used for handling addressable events
   *
   * @param pubkey Public key of the event author
   * @param kind Event kind
   * @param dTagValue Value of the d tag
   * @returns Promise resolving to true if successful, false otherwise
   */
  deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean>;
}
