/**
 * An {@link UpstreamPool} decorator that reports upstream traffic to an
 * observer before delegating to the real pool.
 *
 * This is the whole reason the widget can show *where* an event came from
 * without touching `@nostr-cache/cache-relay`: `NostrRelayOptions.upstreamPool`
 * is a public injection point that takes precedence over `upstreamRelays`, so
 * the relay can be handed an instrumented pool and behaves exactly as it would
 * with the stock one.
 */

import type { UpstreamPool } from '@nostr-cache/cache-relay/browser';
import type { Filter, NostrEvent } from '@nostr-cache/shared';

export interface UpstreamObserver {
  /**
   * An event arrived from an upstream relay. Called *before* the event is
   * handed to the relay, so downstream consumers can rely on the id being
   * recorded by the time the event reaches a client.
   */
  onUpstreamEvent(eventId: string, relayUrl: string): void;
  /** A subscription was opened upstream (read-through kicked in). */
  onUpstreamSubscriptionOpen?(upstreamSubId: string, filters: Filter[]): void;
  /** Every upstream relay answered EOSE for a subscription. */
  onUpstreamEose?(upstreamSubId: string): void;
  /** An event was forwarded upstream (write-through). */
  onUpstreamPublish?(eventId: string): void;
}

export class InstrumentedUpstreamPool implements UpstreamPool {
  constructor(
    private readonly inner: UpstreamPool,
    private readonly observer: UpstreamObserver
  ) {}

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  publish(event: NostrEvent): void {
    this.observer.onUpstreamPublish?.(event.id);
    this.inner.publish(event);
  }

  openSubscription(upstreamSubId: string, filters: Filter[]): void {
    this.observer.onUpstreamSubscriptionOpen?.(upstreamSubId, filters);
    this.inner.openSubscription(upstreamSubId, filters);
  }

  closeSubscription(upstreamSubId: string): void {
    this.inner.closeSubscription(upstreamSubId);
  }

  onEvent(callback: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void): void {
    this.inner.onEvent((upstreamSubId, event, relayUrl) => {
      // Record first: the relay forwards the event to clients synchronously
      // further down this call stack.
      this.observer.onUpstreamEvent(event.id, relayUrl);
      callback(upstreamSubId, event, relayUrl);
    });
  }

  onEose(callback: (upstreamSubId: string) => void): void {
    this.inner.onEose((upstreamSubId) => {
      this.observer.onUpstreamEose?.(upstreamSubId);
      callback(upstreamSubId);
    });
  }

  getConnectedCount(): number {
    return this.inner.getConnectedCount();
  }
}
