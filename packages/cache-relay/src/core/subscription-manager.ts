/**
 * Subscription manager for Nostr Cache Relay
 *
 * Manages client subscriptions
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { eventMatchesFilter } from '../utils/filter-utils.js';
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
   * Get the number of subscriptions for a client
   *
   * @param clientId ID of the client
   * @returns Number of subscriptions
   */
  getClientSubscriptionCount(clientId: string): number {
    return this.clientSubscriptions.get(clientId)?.size || 0;
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
      const matchesEvent = subscription.filters.some((filter) => eventMatchesFilter(event, filter));

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
