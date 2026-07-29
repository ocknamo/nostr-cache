/**
 * Tracks where each timeline event came from: the local cache or an upstream
 * relay.
 *
 * The classification relies on the ordering guaranteed by the relay's
 * read-through path:
 *
 * - An upstream event passes through the upstream pool (recorded here by
 *   {@link recordUpstreamEvent}) *before* the relay validates, stores and
 *   forwards it to the client, so by the time the client sees it the id is
 *   already known to be an upstream one.
 * - A locally cached event is delivered straight from storage, ahead of any
 *   upstream traffic, and `UpstreamCoordinator.markDelivered` seeds the
 *   subscription's dedup set with it — so the inevitable upstream echo of the
 *   same event is dropped rather than re-delivered. It therefore reaches the
 *   client without ever having been recorded here.
 *
 * A classification is made once, when the event is delivered, and never
 * rewritten: an event served from cache stays `cache` even if an upstream
 * relay happens to send it afterwards on another subscription.
 */

export type EventOrigin = 'cache' | 'upstream';

export interface MetricsSnapshot {
  /** Events delivered to the client straight from local storage. */
  cacheHits: number;
  /** Distinct events received from upstream relays. */
  upstreamEvents: number;
  /** Events delivered to the client in total (cacheHits + upstream-delivered). */
  delivered: number;
}

export class CacheMetrics {
  private readonly upstreamSeen = new Set<string>();
  private readonly origins = new Map<string, EventOrigin>();
  private readonly relayByEvent = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private cacheHits = 0;
  private upstreamEvents = 0;

  /**
   * Record an event observed arriving from an upstream relay. Must be called
   * before the event is forwarded on to the relay (see the ordering note in
   * the module docblock).
   *
   * @param eventId Event id as received upstream
   * @param relayUrl URL of the upstream relay that sent it
   */
  recordUpstreamEvent(eventId: string, relayUrl: string): void {
    if (this.upstreamSeen.has(eventId)) {
      return;
    }
    this.upstreamSeen.add(eventId);
    this.relayByEvent.set(eventId, relayUrl);
    this.upstreamEvents += 1;
    this.notify();
  }

  /**
   * Classify an event at the moment it is delivered to the client, and
   * remember the verdict. Repeat calls return the first verdict unchanged.
   *
   * @param eventId Event id delivered to the client
   * @returns Where this event came from
   */
  classifyDelivered(eventId: string): EventOrigin {
    const existing = this.origins.get(eventId);
    if (existing) {
      return existing;
    }
    const origin: EventOrigin = this.upstreamSeen.has(eventId) ? 'upstream' : 'cache';
    this.origins.set(eventId, origin);
    if (origin === 'cache') {
      this.cacheHits += 1;
    }
    this.notify();
    return origin;
  }

  /** The recorded origin of an event, or undefined if it was never delivered. */
  getOrigin(eventId: string): EventOrigin | undefined {
    return this.origins.get(eventId);
  }

  /** The upstream relay an event was first seen on, if it came from upstream. */
  getRelayUrl(eventId: string): string | undefined {
    return this.relayByEvent.get(eventId);
  }

  snapshot(): MetricsSnapshot {
    return {
      cacheHits: this.cacheHits,
      upstreamEvents: this.upstreamEvents,
      delivered: this.origins.size,
    };
  }

  /**
   * Subscribe to counter changes so a UI can re-render.
   *
   * @param listener Called after every recorded change
   * @returns Unsubscribe function
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Forget everything. Used when the cache is cleared for a cold measurement,
   * so the next run classifies from a clean slate.
   */
  reset(): void {
    this.upstreamSeen.clear();
    this.origins.clear();
    this.relayByEvent.clear();
    this.cacheHits = 0;
    this.upstreamEvents = 0;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
