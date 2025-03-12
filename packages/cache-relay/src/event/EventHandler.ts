/**
 * Event handler for Nostr Cache Relay
 *
 * Handles event processing and storage
 */

import { NostrEvent } from '@nostr-cache/types';
import { StorageAdapter } from '../storage/StorageAdapter';
import { EventValidator } from './EventValidator';

/**
 * Event handler class
 * Handles event processing and storage
 */
export class EventHandler {
  private storage: StorageAdapter;
  private validator: EventValidator;

  /**
   * Create a new EventHandler instance
   *
   * @param storage Storage adapter
   */
  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.validator = new EventValidator();
  }

  /**
   * Handle an event
   *
   * @param event Event to handle
   * @returns Promise resolving to true if the event was handled successfully
   */
  async handleEvent(event: NostrEvent): Promise<boolean> {
    // Validate the event
    if (!this.validator.validate(event)) {
      return false;
    }

    // Store the event
    return await this.storage.saveEvent(event);
  }

  /**
   * Check if an event is replaceable
   *
   * @param event Event to check
   * @returns True if the event is replaceable
   * @private
   */
  private isReplaceableEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
  }

  /**
   * Check if an event is ephemeral
   *
   * @param event Event to check
   * @returns True if the event is ephemeral
   * @private
   */
  private isEphemeralEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return kind >= 20000 && kind < 30000;
  }

  /**
   * Check if an event is addressable
   *
   * @param event Event to check
   * @returns True if the event is addressable
   * @private
   */
  private isAddressableEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return kind >= 30000 && kind < 40000;
  }

  /**
   * Get the d tag value from an event
   *
   * @param event Event to get the d tag from
   * @returns The d tag value, or undefined if not found
   * @private
   */
  private getDTagValue(event: NostrEvent): string | undefined {
    const dTag = event.tags.find((tag) => tag[0] === 'd');
    return dTag ? dTag[1] : undefined;
  }
}
