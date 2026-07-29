import { describe, expect, it, vi } from 'vitest';
import { CacheMetrics, UPSTREAM_ATTRIBUTION_WINDOW_MS } from './cache-metrics.ts';

/** Controllable clock so attribution-window behaviour is testable without waiting. */
function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advanceBy: (ms: number) => {
      value += ms;
    },
  };
}

describe('CacheMetrics', () => {
  it('classifies an event as upstream when a sighting explains the delivery', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.getRelayUrl('a')).toBe('wss://relay.example');
  });

  it('classifies a delivery with no sighting as a cache hit', () => {
    const metrics = new CacheMetrics();

    expect(metrics.classifyDelivered('a')).toBe('cache');
    expect(metrics.getRelayUrl('a')).toBeUndefined();
  });

  it('consumes the sighting so a later delivery of the same event is a cache hit', () => {
    // The regression this guards: after an event has been fetched once, every
    // later delivery comes from IndexedDB and must be labelled as such.
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.classifyDelivered('a')).toBe('cache');
    expect(metrics.snapshot()).toEqual({ cacheHits: 1, upstreamEvents: 1, delivered: 2 });
  });

  it('attributes one delivery per sighting when several subscriptions fetch the same event', () => {
    // Two widgets on a page share this instance; each has its own upstream
    // subscription, so the event is genuinely fetched twice.
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.classifyDelivered('a')).toBe('cache');
    // Still one distinct event, however many times it was fetched.
    expect(metrics.snapshot().upstreamEvents).toBe(1);
  });

  it('ignores a sighting that is too old to explain the delivery', () => {
    const clock = fakeClock();
    const metrics = new CacheMetrics(clock.now);
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    clock.advanceBy(UPSTREAM_ATTRIBUTION_WINDOW_MS + 1);

    expect(metrics.classifyDelivered('a')).toBe('cache');
  });

  it('still attributes a sighting inside the window', () => {
    const clock = fakeClock();
    const metrics = new CacheMetrics(clock.now);
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    clock.advanceBy(UPSTREAM_ATTRIBUTION_WINDOW_MS - 1);

    expect(metrics.classifyDelivered('a')).toBe('upstream');
  });

  it('drops expired sightings without consuming a fresh one', () => {
    const clock = fakeClock();
    const metrics = new CacheMetrics(clock.now);
    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    clock.advanceBy(UPSTREAM_ATTRIBUTION_WINDOW_MS + 1);
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.classifyDelivered('a')).toBe('cache');
  });

  it('credits the relay that delivered an event first', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://one.example');
    metrics.recordUpstreamEvent('a', 'wss://two.example');

    expect(metrics.getRelayUrl('a')).toBe('wss://one.example');
  });

  it('tracks cache and upstream counters independently', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    metrics.classifyDelivered('a');
    metrics.classifyDelivered('b');
    metrics.classifyDelivered('c');

    expect(metrics.snapshot()).toEqual({ cacheHits: 2, upstreamEvents: 1, delivered: 3 });
  });

  it('notifies subscribers on a new upstream event and on every delivery', () => {
    const metrics = new CacheMetrics();
    const listener = vi.fn();
    const unsubscribe = metrics.subscribe(listener);

    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    metrics.classifyDelivered('a');
    expect(listener).toHaveBeenCalledTimes(2);

    // A repeat sighting of a known event changes no counter.
    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    metrics.classifyDelivered('b');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('forgets everything on reset so a cold run starts clean', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    metrics.classifyDelivered('a');
    metrics.reset();

    expect(metrics.snapshot()).toEqual({ cacheHits: 0, upstreamEvents: 0, delivered: 0 });
    expect(metrics.getRelayUrl('a')).toBeUndefined();
    // A pending sighting must not survive either, or the next cold run would
    // mislabel a genuine cache miss.
    expect(metrics.classifyDelivered('a')).toBe('cache');
  });
});
