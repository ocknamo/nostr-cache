import { describe, expect, it, vi } from 'vitest';
import { CacheMetrics } from './cache-metrics.ts';

describe('CacheMetrics', () => {
  it('classifies an event as upstream when it was seen upstream first', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.classifyDelivered('a')).toBe('upstream');
    expect(metrics.getRelayUrl('a')).toBe('wss://relay.example');
  });

  it('classifies an unseen event as a cache hit', () => {
    const metrics = new CacheMetrics();

    expect(metrics.classifyDelivered('a')).toBe('cache');
    expect(metrics.getRelayUrl('a')).toBeUndefined();
  });

  it('keeps the first verdict when the same event later arrives from upstream', () => {
    const metrics = new CacheMetrics();
    expect(metrics.classifyDelivered('a')).toBe('cache');

    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    // The event was already shown as a cache hit; re-labelling it afterwards
    // would rewrite history in the UI.
    expect(metrics.classifyDelivered('a')).toBe('cache');
    expect(metrics.getOrigin('a')).toBe('cache');
    expect(metrics.snapshot().cacheHits).toBe(1);
  });

  it('counts a repeated delivery only once', () => {
    const metrics = new CacheMetrics();
    metrics.classifyDelivered('a');
    metrics.classifyDelivered('a');

    expect(metrics.snapshot()).toEqual({ cacheHits: 1, upstreamEvents: 0, delivered: 1 });
  });

  it('counts a repeated upstream sighting only once', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://one.example');
    metrics.recordUpstreamEvent('a', 'wss://two.example');

    expect(metrics.snapshot().upstreamEvents).toBe(1);
    // The first relay to deliver it is the one credited.
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

  it('reports undefined for an event that was never delivered', () => {
    const metrics = new CacheMetrics();
    metrics.recordUpstreamEvent('a', 'wss://relay.example');

    expect(metrics.getOrigin('a')).toBeUndefined();
  });

  it('notifies subscribers on record and classify, and stops after unsubscribe', () => {
    const metrics = new CacheMetrics();
    const listener = vi.fn();
    const unsubscribe = metrics.subscribe(listener);

    metrics.recordUpstreamEvent('a', 'wss://relay.example');
    metrics.classifyDelivered('a');
    expect(listener).toHaveBeenCalledTimes(2);

    // A no-op classify must not spam the UI with re-renders.
    metrics.classifyDelivered('a');
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
    expect(metrics.getOrigin('a')).toBeUndefined();
    // Previously-upstream ids must not linger, or the next cold run would
    // mislabel a genuine cache miss.
    expect(metrics.classifyDelivered('a')).toBe('cache');
  });
});
