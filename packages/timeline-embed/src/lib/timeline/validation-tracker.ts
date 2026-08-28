/**
 * Reads the relay's lazy-validation verdicts for the events on screen. Nothing
 * is verified here — the widget does no crypto.
 */

import type { NostrCacheRelay } from '@nostr-cache/cache-relay/browser';
import {
  type ValidationStatus,
  fetchValidationStatuses,
  hasPending,
} from '../validation-status.ts';

/** Batches the lookups triggered by a burst of incoming events. */
const FETCH_DEBOUNCE_MS = 200;
/** Lazy validation runs in the background, so re-poll while anything is pending. */
const POLL_INTERVAL_MS = 5000;
/**
 * Polls a watch waits before concluding the cache does not hold the event. The
 * retries cover an ingest still in flight, and give a storage read error time
 * to clear before it is read as an absence.
 */
const WATCH_MAX_MISSES = 4;

export interface ValidationTrackerOptions {
  /** The relay to read verdicts from; absent until it has booted. */
  relay(): NostrCacheRelay | undefined;
  /** Every id currently on screen — timeline cards, quotes and replies. */
  ids(): Set<string>;
  /** False once the controller is stopped. */
  isRunning(): boolean;
  /**
   * Applies to {@link watch} only. Paired with the relay's own
   * `lazyValidateInterval`: a caller that speeds verification up wants the
   * watch to notice at the same rate.
   */
  pollIntervalMs?: number;
  onChange(statuses: Map<string, ValidationStatus>): void;
}

export class ValidationTracker {
  private fetchTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  /**
   * Not tied to the current subscription, so {@link clearTimers} leaves it
   * alone; it is bounded by the caller's abort signal instead.
   */
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ValidationTrackerOptions) {}

  schedule(): void {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = undefined;
      void this.refresh();
    }, FETCH_DEBOUNCE_MS);
  }

  /** Drop the subscription-scoped timers, leaving any {@link watch} running. */
  clearTimers(): void {
    clearTimeout(this.fetchTimer);
    clearTimeout(this.pollTimer);
    this.fetchTimer = undefined;
    this.pollTimer = undefined;
  }

  /**
   * Poll until the cache either vouches for one event or stops holding it.
   *
   * **`unknown` does not prove forgery.** The relay reports it for any id with
   * no row: deleted as invalid, deleted by NIP-09, evicted, never ingested, or
   * a broken IndexedDB (a read failure comes back as `unknown` throughout). So
   * `onDropped` means "the cache no longer holds it", and the caller must say
   * that rather than naming a cause it cannot know.
   *
   * An event that never appears is reported too, after
   * {@link WATCH_MAX_MISSES} tries. Waiting for a `pending` sighting first
   * would lose the case that matters most: validation can delete a forged event
   * before the first poll, leaving `unknown` from the outset and a timeline
   * built on it running for the rest of the session.
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
        // Still queued for verification, so the verdict is still to come.
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

    // Only `pending` can still change: `unknown` is terminal (never stored,
    // deleted as invalid, or evicted), so it must not keep polling alive.
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
