/**
 * Tracks where each delivered event came from: the local cache or an upstream
 * relay.
 *
 * The classification relies on the ordering guaranteed by the relay's
 * read-through path. An event fetched upstream passes through the upstream pool
 * (recorded here by {@link CacheMetrics.recordUpstreamEvent}) *before* the relay
 * validates, stores and forwards it to a client, so by the time it reaches the
 * client the sighting is already on record. An event served from storage never
 * passes through the pool at all, and `UpstreamCoordinator.markDelivered` seeds
 * the subscription's dedup set with it so the later upstream echo is dropped
 * rather than re-delivered.
 *
 * Sightings are therefore **consumed** by the delivery they explain, and expire
 * after {@link UPSTREAM_ATTRIBUTION_WINDOW_MS}. Both matter: an id that came
 * from upstream once must not brand every later delivery of that same event as
 * an upstream fetch, or genuine cache hits get mislabelled — which is exactly
 * what happens after the demo's cold/warm benchmark, and whenever two widgets
 * on a page share this instance.
 *
 * Per-view stability is the caller's job: `TimelineController` keeps its own
 * id → origin map per subscription, so a rendered badge never changes under the
 * reader. This class answers "where did *this* delivery come from", once.
 */

/** How long a recorded upstream sighting can still explain a delivery. */
export const UPSTREAM_ATTRIBUTION_WINDOW_MS = 5000;

export type EventOrigin = 'cache' | 'upstream';

export interface MetricsSnapshot {
  /** Deliveries served out of local storage. */
  cacheHits: number;
  /** Distinct events received from upstream relays. */
  upstreamEvents: number;
  /** Deliveries classified in total. */
  delivered: number;
}

export class CacheMetrics {
  /** Upstream sightings awaiting the delivery they explain, by event id. */
  private readonly pendingUpstream = new Map<string, number[]>();
  /** Every id ever seen upstream, for the distinct-event counter. */
  private readonly seenUpstreamIds = new Set<string>();
  private readonly relayByEvent = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private cacheHits = 0;
  private delivered = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record an event observed arriving from an upstream relay. Must be called
   * before the event is forwarded on to the relay (see the module docblock).
   */
  recordUpstreamEvent(eventId: string, relayUrl: string): void {
    const sightings = this.pendingUpstream.get(eventId);
    if (sightings) {
      sightings.push(this.now());
    } else {
      this.pendingUpstream.set(eventId, [this.now()]);
    }

    if (!this.seenUpstreamIds.has(eventId)) {
      this.seenUpstreamIds.add(eventId);
      this.relayByEvent.set(eventId, relayUrl);
      this.notify();
    }
  }

  /**
   * Classify one delivery of an event to a client, consuming the upstream
   * sighting that explains it (if any).
   */
  classifyDelivered(eventId: string): EventOrigin {
    this.delivered += 1;
    const origin: EventOrigin = this.consumeUpstreamSighting(eventId) ? 'upstream' : 'cache';
    if (origin === 'cache') {
      this.cacheHits += 1;
    }
    this.notify();
    return origin;
  }

  /** Take one unexpired sighting for an event, if there is one. */
  private consumeUpstreamSighting(eventId: string): boolean {
    const sightings = this.pendingUpstream.get(eventId);
    if (!sightings) {
      return false;
    }
    const cutoff = this.now() - UPSTREAM_ATTRIBUTION_WINDOW_MS;
    // Sightings are appended in time order, so dropping from the front removes
    // exactly the expired ones.
    while (sightings.length > 0 && sightings[0] < cutoff) {
      sightings.shift();
    }
    const attributable = sightings.length > 0;
    if (attributable) {
      sightings.shift();
    }
    if (sightings.length === 0) {
      this.pendingUpstream.delete(eventId);
    }
    return attributable;
  }

  /** The upstream relay an event was first seen on, if it ever came from one. */
  getRelayUrl(eventId: string): string | undefined {
    return this.relayByEvent.get(eventId);
  }

  snapshot(): MetricsSnapshot {
    return {
      cacheHits: this.cacheHits,
      upstreamEvents: this.seenUpstreamIds.size,
      delivered: this.delivered,
    };
  }

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
    this.pendingUpstream.clear();
    this.seenUpstreamIds.clear();
    this.relayByEvent.clear();
    this.cacheHits = 0;
    this.delivered = 0;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
