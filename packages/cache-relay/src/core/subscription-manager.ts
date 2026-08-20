/**
 * Subscription manager for Nostr Cache Relay
 *
 * Manages client subscriptions
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { compileFilterMatcher } from '../utils/filter-utils.js';
interface Subscription {
  clientId: string;

  id: string;

  filters: Filter[];

  /** When the subscription was created */
  createdAt: number;
}

interface StoredSubscription {
  subscription: Subscription;
  /**
   * One predicate per filter, built once here rather than per event: every
   * stored event is tested against every open subscription.
   */
  matchers: ((event: NostrEvent) => boolean)[];
}

/**
 * Subscription manager class
 * Manages client subscriptions
 */
export class SubscriptionManager {
  private subscriptions: Map<string, StoredSubscription> = new Map();
  private clientSubscriptions: Map<string, Set<string>> = new Map();

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
    this.subscriptions.set(key, { subscription, matchers: filters.map(compileFilterMatcher) });

    // Add to client subscriptions
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }
    this.clientSubscriptions.get(clientId)?.add(subscriptionId);

    return subscription;
  }

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

  getSubscription(clientId: string, subscriptionId: string): Subscription | undefined {
    const key = this.getSubscriptionKey(clientId, subscriptionId);
    return this.subscriptions.get(key)?.subscription;
  }

  getClientSubscriptions(clientId: string): Subscription[] {
    const subscriptionIds = this.clientSubscriptions.get(clientId);

    if (!subscriptionIds) {
      return [];
    }

    const subscriptions: Subscription[] = [];

    for (const subscriptionId of subscriptionIds) {
      const key = this.getSubscriptionKey(clientId, subscriptionId);
      const stored = this.subscriptions.get(key);

      if (stored) {
        subscriptions.push(stored.subscription);
      }
    }

    return subscriptions;
  }

  getAllSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values(), (stored) => stored.subscription);
  }

  /** Get the number of subscriptions for a client */
  getClientSubscriptionCount(clientId: string): number {
    return this.clientSubscriptions.get(clientId)?.size || 0;
  }

  findMatchingSubscriptions(event: NostrEvent): Map<string, Subscription[]> {
    const matches = new Map<string, Subscription[]>();

    for (const { subscription, matchers } of this.subscriptions.values()) {
      // Check if any filter matches the event
      const matchesEvent = matchers.some((matchesFilter) => matchesFilter(event));

      if (matchesEvent) {
        if (!matches.has(subscription.clientId)) {
          matches.set(subscription.clientId, []);
        }

        matches.get(subscription.clientId)?.push(subscription);
      }
    }

    return matches;
  }

  private getSubscriptionKey(clientId: string, subscriptionId: string): string {
    return `${clientId}:${subscriptionId}`;
  }
}
