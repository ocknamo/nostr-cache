import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IngestResult, UpstreamCoordinator } from './upstream-coordinator.js';
import type { UpstreamPool } from './upstream-types.js';

function makeEvent(id: string, kind = 1): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind, tags: [], content: '', sig: '' };
}

/** In-memory mock pool that records calls and lets the test emit events/EOSE. */
class MockPool implements UpstreamPool {
  eventCb?: (subId: string, event: NostrEvent, relayUrl: string) => void;
  eoseCb?: (subId: string) => void;
  readonly opened: Array<{ subId: string; filters: Filter[] }> = [];
  readonly closed: string[] = [];
  readonly published: NostrEvent[] = [];
  started = false;
  stopped = false;
  connectedCount = 1;

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  publish(event: NostrEvent): void {
    this.published.push(event);
  }
  openSubscription(subId: string, filters: Filter[]): void {
    this.opened.push({ subId, filters });
  }
  closeSubscription(subId: string): void {
    this.closed.push(subId);
  }
  onEvent(cb: (subId: string, event: NostrEvent, relayUrl: string) => void): void {
    this.eventCb = cb;
  }
  onEose(cb: (subId: string) => void): void {
    this.eoseCb = cb;
  }
  getConnectedCount(): number {
    return this.connectedCount;
  }
  // Test helpers
  emitEvent(subId: string, event: NostrEvent): void {
    this.eventCb?.(subId, event, 'wss://relay');
  }
  emitEose(subId: string): void {
    this.eoseCb?.(subId);
  }
  lastSubId(): string {
    return this.opened[this.opened.length - 1].subId;
  }
}

interface Harness {
  pool: MockPool;
  coordinator: UpstreamCoordinator;
  deliver: ReturnType<typeof vi.fn>;
  sendEose: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
}

function makeHarness(
  ingestImpl: (event: NostrEvent) => Promise<IngestResult> = async () => ({
    success: true,
    stored: true,
  }),
  options?: { eoseTimeout?: number; maxSentIdsPerSub?: number }
): Harness {
  const pool = new MockPool();
  const deliver = vi.fn();
  const sendEose = vi.fn();
  const ingest = vi.fn(ingestImpl);
  // The coordinator wires the pool's onEvent/onEose callbacks in its
  // constructor, so the test helpers can emit events/EOSE without start().
  const coordinator = new UpstreamCoordinator({ pool, ingest, deliver, sendEose }, options);
  return { pool, coordinator, deliver, sendEose, ingest };
}

/** Let queued ingest promise chains settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UpstreamCoordinator', () => {
  it('start wires callbacks and starts the pool', async () => {
    const { pool, coordinator } = makeHarness();
    await coordinator.start();
    expect(pool.started).toBe(true);
    expect(pool.eventCb).toBeDefined();
    expect(pool.eoseCb).toBeDefined();
  });

  it('opens an upstream subscription with a short (<=64 char) id', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    expect(pool.opened).toHaveLength(1);
    expect(pool.opened[0].subId.length).toBeLessThanOrEqual(64);
    expect(pool.opened[0].filters).toEqual([{ kinds: [1] }]);
  });

  it('ingests, dedupes and delivers an upstream event', async () => {
    const { pool, coordinator, deliver, ingest } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const event = makeEvent('a');
    pool.emitEvent(pool.lastSubId(), event);
    await flush();

    expect(ingest).toHaveBeenCalledWith(event);
    expect(deliver).toHaveBeenCalledWith('client', 'sub', event);
  });

  it('does not deliver an event already sent from local storage', async () => {
    const { pool, coordinator, deliver, ingest } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], ['a']);
    pool.emitEvent(pool.lastSubId(), makeEvent('a'));
    await flush();

    expect(ingest).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a duplicate event from two relays only once', async () => {
    const { pool, coordinator, deliver } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    const event = makeEvent('a');
    pool.emitEvent(subId, event);
    pool.emitEvent(subId, event);
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not deliver events that fail ingest (e.g. invalid)', async () => {
    const { pool, coordinator, deliver } = makeHarness(async () => ({
      success: false,
      stored: false,
    }));
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    pool.emitEvent(pool.lastSubId(), makeEvent('a'));
    await flush();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers accepted-but-unstored (ephemeral) events', async () => {
    const { pool, coordinator, deliver } = makeHarness(async () => ({
      success: true,
      stored: false,
    }));
    coordinator.openForSubscription('client', 'sub', [{ kinds: [20000] }], []);
    pool.emitEvent(pool.lastSubId(), makeEvent('a', 20000));
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  describe('EOSE', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends client EOSE when the aggregated upstream EOSE arrives', () => {
      const { pool, coordinator, sendEose } = makeHarness();
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose(pool.lastSubId());
      expect(sendEose).toHaveBeenCalledWith('client', 'sub');
    });

    it('sends client EOSE after the timeout if upstream is silent', () => {
      const { coordinator, sendEose } = makeHarness(undefined, { eoseTimeout: 500 });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      expect(sendEose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(sendEose).toHaveBeenCalledWith('client', 'sub');
    });

    it('sends client EOSE only once (aggregate then timeout)', () => {
      const { pool, coordinator, sendEose } = makeHarness(undefined, { eoseTimeout: 500 });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose(pool.lastSubId());
      vi.advanceTimersByTime(500);
      expect(sendEose).toHaveBeenCalledTimes(1);
    });
  });

  it('closeForSubscription closes the upstream sub and stops delivering', async () => {
    const { pool, coordinator, deliver } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    coordinator.closeForSubscription('client', 'sub');
    expect(pool.closed).toContain(subId);

    // An event arriving after close is dropped.
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a REQ reusing a subscription id closes the previous upstream sub', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const first = pool.lastSubId();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [2] }], []);
    expect(pool.closed).toContain(first);
    expect(pool.opened).toHaveLength(2);
  });

  it('closeAllForClient closes every subscription of that client only', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub1', [{ kinds: [1] }], []);
    coordinator.openForSubscription('client', 'sub2', [{ kinds: [2] }], []);
    coordinator.openForSubscription('other', 'sub3', [{ kinds: [3] }], []);
    const [s1, s2, s3] = pool.opened.map((o) => o.subId);

    coordinator.closeAllForClient('client');
    expect(pool.closed).toContain(s1);
    expect(pool.closed).toContain(s2);
    expect(pool.closed).not.toContain(s3);
  });

  it('publish forwards to the pool', () => {
    const { pool, coordinator } = makeHarness();
    const event = makeEvent('x');
    coordinator.publish(event);
    expect(pool.published).toEqual([event]);
  });

  it('bounds the dedup set to maxSentIdsPerSub', async () => {
    const { pool, coordinator, deliver } = makeHarness(undefined, { maxSentIdsPerSub: 2 });
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    pool.emitEvent(subId, makeEvent('b'));
    await flush();
    pool.emitEvent(subId, makeEvent('c')); // evicts 'a'
    await flush();
    expect(deliver).toHaveBeenCalledTimes(3);

    // 'a' was evicted from the dedup set, so it is delivered again.
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it('stop clears state and stops the pool', async () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    await coordinator.stop();
    expect(pool.stopped).toBe(true);
  });
});
