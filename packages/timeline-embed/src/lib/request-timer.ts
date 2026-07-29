/**
 * Measures how long a REQ takes to produce results, which is what makes the
 * cache visible: a cold run (empty cache) has to wait for the upstream relays,
 * a warm run answers from IndexedDB.
 *
 * The clock is injectable so specs can drive it deterministically instead of
 * sleeping.
 */

export interface RequestTiming {
  startedAt: number;
  firstEventAt?: number;
  eoseAt?: number;
  eventCount: number;
}

export interface RequestDurations {
  /** ms from REQ to the first EVENT, or undefined if none arrived. */
  timeToFirstEvent?: number;
  /** ms from REQ to EOSE, or undefined if EOSE has not arrived yet. */
  timeToEose?: number;
  eventCount: number;
}

export class RequestTimer {
  private readonly timings = new Map<string, RequestTiming>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Begin timing a subscription. Restarts the clock if the key is reused. */
  start(key: string): void {
    this.timings.set(key, { startedAt: this.now(), eventCount: 0 });
  }

  /** Record an EVENT. Only the first one moves `firstEventAt`. */
  markEvent(key: string): void {
    const timing = this.timings.get(key);
    if (!timing) {
      return;
    }
    timing.eventCount += 1;
    if (timing.firstEventAt === undefined) {
      timing.firstEventAt = this.now();
    }
  }

  /** Record EOSE. Ignored if EOSE was already seen for this key. */
  markEose(key: string): void {
    const timing = this.timings.get(key);
    if (!timing || timing.eoseAt !== undefined) {
      return;
    }
    timing.eoseAt = this.now();
  }

  /** Elapsed times for a key, or undefined if it was never started. */
  durations(key: string): RequestDurations | undefined {
    const timing = this.timings.get(key);
    if (!timing) {
      return undefined;
    }
    return {
      timeToFirstEvent:
        timing.firstEventAt === undefined ? undefined : timing.firstEventAt - timing.startedAt,
      timeToEose: timing.eoseAt === undefined ? undefined : timing.eoseAt - timing.startedAt,
      eventCount: timing.eventCount,
    };
  }

  /** Whether EOSE has been recorded for a key. */
  isComplete(key: string): boolean {
    return this.timings.get(key)?.eoseAt !== undefined;
  }

  clear(): void {
    this.timings.clear();
  }
}
