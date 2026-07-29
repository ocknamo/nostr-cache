import type { UpstreamPool } from '@nostr-cache/cache-relay/browser';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it, vi } from 'vitest';
import { CacheMetrics } from './cache-metrics.ts';
import { InstrumentedUpstreamPool, type UpstreamObserver } from './instrumented-upstream-pool.ts';

function createEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: 'f'.repeat(64),
    created_at: 1000,
    kind: 1,
    tags: [],
    content: 'hello',
    sig: '0'.repeat(128),
  };
}

/** Mock pool that lets the spec fire the callbacks the real pool would. */
function createMockPool() {
  let eventCallback: ((subId: string, event: NostrEvent, relayUrl: string) => void) | undefined;
  let eoseCallback: ((subId: string) => void) | undefined;

  const pool = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    publish: vi.fn(),
    openSubscription: vi.fn(),
    closeSubscription: vi.fn(),
    onEvent: vi.fn((cb) => {
      eventCallback = cb;
    }),
    onEose: vi.fn((cb) => {
      eoseCallback = cb;
    }),
    getConnectedCount: vi.fn(() => 2),
  } satisfies UpstreamPool;

  return {
    pool,
    emitEvent: (subId: string, event: NostrEvent, relayUrl: string) =>
      eventCallback?.(subId, event, relayUrl),
    emitEose: (subId: string) => eoseCallback?.(subId),
  };
}

function createObserver(): UpstreamObserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onUpstreamEvent: (eventId, relayUrl) => calls.push(`event:${eventId}:${relayUrl}`),
    onUpstreamEose: (subId) => calls.push(`eose:${subId}`),
    onUpstreamSubscriptionOpen: (subId) => calls.push(`open:${subId}`),
    onUpstreamPublish: (eventId) => calls.push(`publish:${eventId}`),
  };
}

describe('InstrumentedUpstreamPool', () => {
  it('delegates every method to the wrapped pool', async () => {
    const { pool } = createMockPool();
    const instrumented = new InstrumentedUpstreamPool(pool, createObserver());
    const filters: Filter[] = [{ kinds: [1] }];
    const event = createEvent('a');

    await instrumented.start();
    instrumented.publish(event);
    instrumented.openSubscription('sub', filters);
    instrumented.closeSubscription('sub');
    await instrumented.stop();

    expect(pool.start).toHaveBeenCalledOnce();
    expect(pool.publish).toHaveBeenCalledWith(event);
    expect(pool.openSubscription).toHaveBeenCalledWith('sub', filters);
    expect(pool.closeSubscription).toHaveBeenCalledWith('sub');
    expect(pool.stop).toHaveBeenCalledOnce();
    expect(instrumented.getConnectedCount()).toBe(2);
  });

  it('reports an upstream event and still forwards it to the relay', () => {
    const { pool, emitEvent } = createMockPool();
    const observer = createObserver();
    const instrumented = new InstrumentedUpstreamPool(pool, observer);
    const received: string[] = [];
    instrumented.onEvent((_subId, event) => received.push(event.id));

    emitEvent('sub', createEvent('a'), 'wss://relay.example');

    expect(observer.calls).toContain('event:a:wss://relay.example');
    expect(received).toEqual(['a']);
  });

  it('records an upstream event before the relay forwards it downstream', () => {
    // This ordering is what makes origin classification correct: the relay
    // delivers the event to clients synchronously inside its own onEvent
    // handler, so the id must already be recorded by then.
    const { pool, emitEvent } = createMockPool();
    const metrics = new CacheMetrics();
    const instrumented = new InstrumentedUpstreamPool(pool, {
      onUpstreamEvent: (eventId, relayUrl) => metrics.recordUpstreamEvent(eventId, relayUrl),
    });

    let originAtDelivery: string | undefined;
    instrumented.onEvent((_subId, event) => {
      originAtDelivery = metrics.classifyDelivered(event.id);
    });
    emitEvent('sub', createEvent('a'), 'wss://relay.example');

    expect(originAtDelivery).toBe('upstream');
  });

  it('reports EOSE and still forwards it', () => {
    const { pool, emitEose } = createMockPool();
    const observer = createObserver();
    const instrumented = new InstrumentedUpstreamPool(pool, observer);
    const forwarded: string[] = [];
    instrumented.onEose((subId) => forwarded.push(subId));

    emitEose('sub');

    expect(observer.calls).toContain('eose:sub');
    expect(forwarded).toEqual(['sub']);
  });

  it('works with an observer that only implements the required hook', () => {
    const { pool, emitEose } = createMockPool();
    const instrumented = new InstrumentedUpstreamPool(pool, { onUpstreamEvent: () => {} });
    const forwarded: string[] = [];
    instrumented.onEose((subId) => forwarded.push(subId));

    instrumented.publish(createEvent('a'));
    instrumented.openSubscription('sub', []);
    emitEose('sub');

    expect(forwarded).toEqual(['sub']);
  });
});
