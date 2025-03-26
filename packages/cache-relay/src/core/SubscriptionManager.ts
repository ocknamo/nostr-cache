/**
 * Subscription manager for Nostr Cache Relay
 *
 * Manages client subscriptions
 */

import type { Filter, NostrEvent } from '@nostr-cache/types';
import type { StorageAdapter } from '../storage/StorageAdapter';

/**
 * Subscription information
 */
interface Subscription {
  /**
   * ID of the client that created the subscription
   */
  clientId: string;

  /**
   * ID of the subscription
   */
  id: string;

  /**
   * Filters for the subscription
   */
  filters: Filter[];

  /**
   * When the subscription was created
   */
  createdAt: number;
}

/**
 * Subscription manager class
 * Manages client subscriptions
 */
export class SubscriptionManager {
  private subscriptions: Map<string, Subscription> = new Map();
  private clientSubscriptions: Map<string, Set<string>> = new Map();
  private storage: StorageAdapter;

  /**
   * Create a new SubscriptionManager instance
   *
   * @param storage Storage adapter
   */
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  /**
   * Create a new subscription
   *
   * @param clientId ID of the client creating the subscription
   * @param subscriptionId ID of the subscription
   * @param filters Filters for the subscription
   * @returns The created subscription
   */
  createSubscription(clientId: string, subscriptionId: string, filters: Filter[]): Subscription {
    // Remove any existing subscription with the same ID
    this.removeSubscription(clientId, subscriptionId);

    // Create the subscription
    const subscription: Subscription = {
      clientId,
      id: subscriptionId,
      filters,
      createdAt: Date.now(),
    };

    // Store the subscription
    const key = this.getSubscriptionKey(clientId, subscriptionId);
    this.subscriptions.set(key, subscription);

    // Add to client subscriptions
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }
    this.clientSubscriptions.get(clientId)?.add(subscriptionId);

    return subscription;
  }

  /**
   * Remove a subscription
   *
   * @param clientId ID of the client that created the subscription
   * @param subscriptionId ID of the subscription
   * @returns True if the subscription was removed, false if it didn't exist
   */
  removeSubscription(clientId: string, subscriptionId: string): boolean {
    const key = this.getSubscriptionKey(clientId, subscriptionId);
    const removed = this.subscriptions.delete(key);

    if (removed) {
      // Remove from client subscriptions
      this.clientSubscriptions.get(clientId)?.delete(subscriptionId);

      // Remove client subscriptions set if empty
      if (this.clientSubscriptions.get(clientId)?.size === 0) {
        this.clientSubscriptions.delete(clientId);
      }
    }

    return removed;
  }

  /**
   * Remove all subscriptions for a client
   *
   * @param clientId ID of the client
   * @returns Number of subscriptions removed
   */
  removeAllSubscriptions(clientId: string): number {
    const subscriptionIds = this.clientSubscriptions.get(clientId);

    if (!subscriptionIds) {
      return 0;
    }

    let count = 0;

    for (const subscriptionId of subscriptionIds) {
      const key = this.getSubscriptionKey(clientId, subscriptionId);
      if (this.subscriptions.delete(key)) {
        count++;
      }
    }

    this.clientSubscriptions.delete(clientId);

    return count;
  }

  /**
   * Remove a subscription by ID for all clients
   *
   * @param subscriptionId ID of the subscription
   * @returns Number of subscriptions removed
   */
  removeSubscriptionByIdForAllClients(subscriptionId: string): number {
    let count = 0;

    for (const [clientId, subscriptionIds] of this.clientSubscriptions.entries()) {
      if (subscriptionIds.has(subscriptionId)) {
        const key = this.getSubscriptionKey(clientId, subscriptionId);
        if (this.subscriptions.delete(key)) {
          count++;
          subscriptionIds.delete(subscriptionId);

          // Remove client subscriptions set if empty
          if (subscriptionIds.size === 0) {
            this.clientSubscriptions.delete(clientId);
          }
        }
      }
    }

    return count;
  }

  /**
   * Get a subscription
   *
   * @param clientId ID of the client that created the subscription
   * @param subscriptionId ID of the subscription
   * @returns The subscription, or undefined if it doesn't exist
   */
  getSubscription(clientId: string, subscriptionId: string): Subscription | undefined {
    const key = this.getSubscriptionKey(clientId, subscriptionId);
    return this.subscriptions.get(key);
  }

  /**
   * Get all subscriptions for a client
   *
   * @param clientId ID of the client
   * @returns Array of subscriptions
   */
  getClientSubscriptions(clientId: string): Subscription[] {
    const subscriptionIds = this.clientSubscriptions.get(clientId);

    if (!subscriptionIds) {
      return [];
    }

    const subscriptions: Subscription[] = [];

    for (const subscriptionId of subscriptionIds) {
      const key = this.getSubscriptionKey(clientId, subscriptionId);
      const subscription = this.subscriptions.get(key);

      if (subscription) {
        subscriptions.push(subscription);
      }
    }

    return subscriptions;
  }

  /**
   * Get all subscriptions
   *
   * @returns Array of all subscriptions
   */
  getAllSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Find subscriptions that match an event
   *
   * @param event Event to match
   * @returns Map of client IDs to arrays of matching subscriptions
   */
  findMatchingSubscriptions(event: NostrEvent): Map<string, Subscription[]> {
    const matches = new Map<string, Subscription[]>();

    for (const subscription of this.subscriptions.values()) {
      // Check if any filter matches the event
      const matchesEvent = subscription.filters.some((filter) =>
        this.eventMatchesFilter(event, filter)
      );

      if (matchesEvent) {
        if (!matches.has(subscription.clientId)) {
          matches.set(subscription.clientId, []);
        }

        matches.get(subscription.clientId)?.push(subscription);
      }
    }

    return matches;
  }

  /**
   * Check if an event matches a filter
   *
   * @param event Event to check
   * @param filter Filter to check against
   * @returns True if the event matches the filter
   * @private
   */
  private eventMatchesFilter(event: NostrEvent, filter: Filter): boolean {
    // This is a placeholder implementation
    // In a real implementation, this would check all filter criteria

    // Check ids
    if (filter.ids && !filter.ids.includes(event.id)) {
      return false;
    }

    // Check authors
    if (filter.authors && !filter.authors.includes(event.pubkey)) {
      return false;
    }

    // Check kinds
    if (filter.kinds && !filter.kinds.includes(event.kind)) {
      return false;
    }

    // Check since
    if (filter.since && event.created_at < filter.since) {
      return false;
    }

    // Check until
    if (filter.until && event.created_at > filter.until) {
      return false;
    }

    // Check tag filters (e.g. #e, #p)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const tagName = key.slice(1);
        const eventTags = event.tags.filter((tag) => tag[0] === tagName);
        const eventTagValues = eventTags.map((tag) => tag[1]);

        // Check if any of the filter values match any of the event tag values
        const hasMatch = (values as string[]).some((value) => eventTagValues.includes(value));

        if (!hasMatch) {
          return false;
        }
      }
    }

    // If we got here, the event matches the filter
    return true;
  }

  /**
   * Get the key for a subscription
   *
   * @param clientId ID of the client
   * @param subscriptionId ID of the subscription
   * @returns Key for the subscription
   * @private
   */
  private getSubscriptionKey(clientId: string, subscriptionId: string): string {
    return `${clientId}:${subscriptionId}`;
  }
}
