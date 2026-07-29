import type { RelayConnection } from '@nostr-cache/timeline-embed';
import { describe, expect, it, vi } from 'vitest';
import { type BenchmarkResult, runBenchmark, speedup } from './benchmark.ts';

/**
 * Stand-in for RelayConnection that lets a spec script exactly when EVENT and
 * EOSE arrive, on a clock the spec also controls.
 */
function createFakeConnection(script: {
  eventsAt: number[];
  eoseAt?: number;
  clock: { advanceTo: (value: number) => void };
}) {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    unsubscribe: vi.fn(),
    subscribe: vi.fn((_subId, _filters, handlers) => {
      for (const at of script.eventsAt) {
        script.clock.advanceTo(at);
        handlers.onEvent({} as never);
      }
      if (script.eoseAt !== undefined) {
        script.clock.advanceTo(script.eoseAt);
        handlers.onEose?.();
      }
    }),
  } as unknown as RelayConnection;
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advanceTo: (next: number) => {
      value = next;
    },
  };
}

describe('runBenchmark', () => {
  it('clears the cache once, before the cold pass only', async () => {
    const clock = fakeClock();
    const clearCache = vi.fn(async () => {});
    const order: string[] = [];
    let pass = 0;

    await runBenchmark({
      interceptUrl: 'ws://test.invalid',
      filter: { kinds: [1] },
      now: clock.now,
      clearCache: async () => {
        order.push('clear');
        await clearCache();
      },
      createConnection: () => {
        pass += 1;
        order.push(`pass-${pass}`);
        return createFakeConnection({ eventsAt: [10], eoseAt: 20, clock });
      },
    });

    expect(clearCache).toHaveBeenCalledOnce();
    // The warm pass must reuse whatever the cold pass just cached.
    expect(order).toEqual(['clear', 'pass-1', 'pass-2']);
  });

  it('measures both passes against the same filter', async () => {
    const clock = fakeClock();
    const timings = [
      { eventsAt: [800], eoseAt: 900 },
      { eventsAt: [1005], eoseAt: 1100 },
    ];
    let index = 0;

    const result = await runBenchmark({
      interceptUrl: 'ws://test.invalid',
      filter: { kinds: [1] },
      now: clock.now,
      clearCache: async () => {},
      createConnection: () => {
        const script = timings[index];
        index += 1;
        // Each pass starts timing at the clock's current value.
        return createFakeConnection({ ...script, clock });
      },
    });

    expect(result.cold.timeToFirstEvent).toBe(800);
    expect(result.cold.timeToEose).toBe(900);
    expect(result.cold.eventCount).toBe(1);
    // The warm pass starts at 900 (where the cold one left the clock).
    expect(result.warm.timeToFirstEvent).toBe(105);
    expect(result.warm.timedOut).toBe(false);
  });

  it('closes each pass so it cannot keep filling the cache during the next one', async () => {
    const clock = fakeClock();
    const connections: ReturnType<typeof createFakeConnection>[] = [];

    await runBenchmark({
      interceptUrl: 'ws://test.invalid',
      filter: { kinds: [1] },
      now: clock.now,
      clearCache: async () => {},
      createConnection: () => {
        const connection = createFakeConnection({ eventsAt: [], eoseAt: 5, clock });
        connections.push(connection);
        return connection;
      },
    });

    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      expect(connection.unsubscribe).toHaveBeenCalledOnce();
      expect(connection.disconnect).toHaveBeenCalledOnce();
    }
  });

  it('gives up on a pass that never reaches EOSE', async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    try {
      const promise = runBenchmark({
        interceptUrl: 'ws://test.invalid',
        filter: { kinds: [1] },
        now: clock.now,
        timeoutMs: 1000,
        clearCache: async () => {},
        createConnection: () => createFakeConnection({ eventsAt: [30], clock }),
      });
      await vi.advanceTimersByTimeAsync(2500);
      const result = await promise;

      expect(result.cold.timedOut).toBe(true);
      expect(result.cold.timeToEose).toBeUndefined();
      // An event still arrived, so that measurement is usable.
      expect(result.cold.timeToFirstEvent).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records no first-event time when a pass returns nothing', async () => {
    const clock = fakeClock();
    const result = await runBenchmark({
      interceptUrl: 'ws://test.invalid',
      filter: { kinds: [1] },
      now: clock.now,
      clearCache: async () => {},
      createConnection: () => createFakeConnection({ eventsAt: [], eoseAt: 40, clock }),
    });

    expect(result.cold.timeToFirstEvent).toBeUndefined();
    expect(result.cold.eventCount).toBe(0);
  });
});

describe('speedup', () => {
  function result(cold?: number, warm?: number): BenchmarkResult {
    return {
      cold: { timeToFirstEvent: cold, eventCount: 1, timedOut: false },
      warm: { timeToFirstEvent: warm, eventCount: 1, timedOut: false },
    };
  }

  it('divides cold by warm', () => {
    expect(speedup(result(800, 10))).toBe(80);
  });

  it('is undefined when either pass produced no event', () => {
    expect(speedup(result(undefined, 10))).toBeUndefined();
    expect(speedup(result(800, undefined))).toBeUndefined();
  });

  it('is undefined when the warm pass was too fast to divide by', () => {
    expect(speedup(result(800, 0))).toBeUndefined();
  });
});
