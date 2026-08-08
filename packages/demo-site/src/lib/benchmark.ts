/**
 * Cold-vs-warm measurement: the demo's headline evidence that the cache works.
 *
 * A cold pass runs against an emptied cache, so every event has to come from
 * the upstream relays. A warm pass runs the identical REQ again, now with the
 * events sitting in IndexedDB.
 *
 * Read the two metrics differently:
 *
 * - **Time to first event** is where the cache shows up. A warm pass answers
 *   out of local storage immediately, without waiting for a single network
 *   round trip.
 * - **Time to EOSE** stays roughly the same, and that is correct, not a bug:
 *   read-through forwards every REQ upstream so the cache keeps converging on
 *   the relays' state, and the client's EOSE is held until the upstream EOSE is
 *   aggregated (bounded by `upstreamEoseTimeout`). A cache that skipped the
 *   upstream would be fast and stale.
 */

import type { Filter } from '@nostr-cache/shared';
import { RelayConnection, RequestTimer } from '@nostr-cache/timeline-embed';

/** Upper bound on one pass, so a dead upstream cannot hang the demo. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface BenchmarkPass {
  /** ms until the first event reached the client. */
  timeToFirstEvent?: number;
  /** ms until EOSE, or undefined if the pass timed out first. */
  timeToEose?: number;
  eventCount: number;
  /** True when the pass hit {@link BenchmarkOptions.timeoutMs} before EOSE. */
  timedOut: boolean;
}

export interface BenchmarkResult {
  cold: BenchmarkPass;
  warm: BenchmarkPass;
}

export interface BenchmarkOptions {
  /** URL the in-page relay is served on. */
  interceptUrl: string;
  filter: Filter;
  /** Empties the cache so the cold pass really is cold. */
  clearCache: () => Promise<void>;
  /** Injectable for tests; defaults to a real NIP-01 connection. */
  createConnection?: () => RelayConnection;
  now?: () => number;
  timeoutMs?: number;
}

/** Run a cold pass followed by a warm one against the same filter. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  await options.clearCache();
  const cold = await measurePass('bench-cold', options);
  // No clearing in between: the warm pass deliberately reuses what the cold
  // pass just cached.
  const warm = await measurePass('bench-warm', options);
  return { cold, warm };
}

async function measurePass(subId: string, options: BenchmarkOptions): Promise<BenchmarkPass> {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connection = options.createConnection?.() ?? new RelayConnection();
  const timer = new RequestTimer(now);

  await connection.connect(options.interceptUrl);

  let timedOut = false;
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);

      timer.start(subId);
      connection.subscribe(subId, [options.filter], {
        onEvent: () => timer.markEvent(subId),
        onEose: () => {
          timer.markEose(subId);
          clearTimeout(timeout);
          resolve();
        },
        onClosed: () => {
          clearTimeout(timeout);
          resolve();
        },
      });
    });
  } finally {
    connection.unsubscribe(subId);
    // Drop the socket so the pass leaves no live subscription behind to keep
    // filling the cache while the next pass is being measured.
    connection.disconnect();
  }

  const durations = timer.durations(subId);
  return {
    timeToFirstEvent: durations?.timeToFirstEvent,
    timeToEose: durations?.timeToEose,
    eventCount: durations?.eventCount ?? 0,
    timedOut,
  };
}

/**
 * How many times faster the warm pass produced its first event. Undefined when
 * either pass produced none, or when the warm pass was too fast to divide by.
 */
export function speedup(result: BenchmarkResult): number | undefined {
  const cold = result.cold.timeToFirstEvent;
  const warm = result.warm.timeToFirstEvent;
  if (cold === undefined || warm === undefined || warm <= 0) {
    return undefined;
  }
  return cold / warm;
}
