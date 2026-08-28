/** Reads the relay's lazy-validation verdicts; the widget does no crypto. */

import type { NostrCacheRelay } from '@nostr-cache/cache-relay/browser';
import {
  type ValidationStatus,
  fetchValidationStatuses,
  hasPending,
} from '../validation-status.ts';

/** Batches the lookups triggered by a burst of incoming events. */
const FETCH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 5000;
/**
 * Retries before a watch concludes the cache does not hold the event: they
 * cover an ingest still in flight, and a storage read error that may clear.
 */
const WATCH_MAX_MISSES = 4;

export interface ValidationTrackerOptions {
  /** Absent until the relay has booted. */
  relay(): NostrCacheRelay | undefined;
  /** Every id on screen — timeline cards, quotes and replies. */
  ids(): Set<string>;
  isRunning(): boolean;
  /**
   * Applies to {@link watch} only. Pairs with the relay's own
   * `lazyValidateInterval`, so speeding verification up speeds the watch up.
   */
  pollIntervalMs?: number;
  onChange(statuses: Map<string, ValidationStatus>): void;
}

export class ValidationTracker {
  private fetchTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  /** Bounded by the caller's abort signal, not by {@link clearTimers}. */
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ValidationTrackerOptions) {}

  schedule(): void {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = undefined;
      void this.refresh();
    }, FETCH_DEBOUNCE_MS);
  }

  /** Leaves any {@link watch} running. */
  clearTimers(): void {
    clearTimeout(this.fetchTimer);
    clearTimeout(this.pollTimer);
    this.fetchTimer = undefined;
    this.pollTimer = undefined;
  }

  /**
   * **`unknown` does not prove forgery.** The relay reports it for any id with
   * no row — deleted as invalid, deleted by NIP-09, evicted, never ingested, or
   * a broken IndexedDB. So `onDropped` means only "the cache no longer holds
   * it", and the caller must not name a cause it cannot know.
   *
   * An event that never appears is reported too. Waiting for a `pending`
   * sighting first would lose the case that matters most: validation can delete
   * a forged event before the first poll, leaving `unknown` from the outset.
   */
  watch(eventId: string, signal: AbortSignal, onDropped: () => void): void {
    let misses = 0;

    const poll = async (): Promise<void> => {
      const relay = this.options.relay();
      if (!relay || !this.options.isRunning() || signal.aborted) {
        return;
      }
      let statuses: Map<string, ValidationStatus>;
      try {
        statuses = await fetchValidationStatuses(relay, [eventId]);
      } catch {
        // A failed lookup is not evidence of anything; try again.
        schedule();
        return;
      }
      if (!this.options.isRunning() || signal.aborted) {
        return;
      }
      const status = statuses.get(eventId);
      if (status === 'validated') {
        return;
      }
      if (status === 'pending') {
        misses = 0;
        schedule();
        return;
      }
      misses += 1;
      if (misses >= WATCH_MAX_MISSES) {
        onDropped();
        return;
      }
      schedule();
    };

    const schedule = (): void => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = undefined;
        void poll();
      }, this.pollInterval());
    };
    signal.addEventListener('abort', () => clearTimeout(this.watchTimer), { once: true });

    void poll();
  }

  private pollInterval(): number {
    return this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  private async refresh(): Promise<void> {
    const relay = this.options.relay();
    const ids = this.options.ids();
    if (!relay || ids.size === 0) {
      return;
    }
    let statuses: Map<string, ValidationStatus>;
    try {
      statuses = await fetchValidationStatuses(relay, [...ids]);
    } catch {
      // A failed lookup only costs us the ✓ badges; the timeline is unaffected.
      return;
    }
    if (!this.options.isRunning()) {
      return;
    }
    this.options.onChange(statuses);

    // Only `pending` can still change; `unknown` is terminal.
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (hasPending(statuses)) {
      // The constant, not {@link pollInterval}: shortening the watch interval
      // is not a request to re-read the whole timeline that often.
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        void this.refresh();
      }, POLL_INTERVAL_MS);
    }
  }
}
