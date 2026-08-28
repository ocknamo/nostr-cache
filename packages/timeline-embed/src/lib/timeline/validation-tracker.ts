/**
 * Reads the relay's lazy-validation verdicts for the events on screen.
 *
 * Nothing is verified here — the widget does no crypto; it only polls for what
 * the relay has already decided.
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
 * How many polls a watch waits for the event to appear in storage before
 * concluding the cache does not hold it.
 *
 * Deliveries are stored before they reach the client, so the first look
 * normally finds the event already. The retries cover an ingest that is still
 * in flight — and, because the poll interval is 5s, they also give a storage
 * read error time to clear before it is read as an absence.
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
   * Seconds between re-checks, as milliseconds.
   *
   * Paired with the relay's own `lazyValidateInterval`: a caller that speeds
   * verification up wants the widget to notice at the same rate. Specs use it to
   * avoid spending {@link WATCH_MAX_MISSES} real poll intervals.
   */
  pollIntervalMs?: number;
  onChange(statuses: Map<string, ValidationStatus>): void;
}

export class ValidationTracker {
  private fetchTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  /**
   * Kept apart from the two timers above because it is not tied to the current
   * subscription: the event it watches was fetched before that subscription
   * existed, so {@link clearTimers} clearing it would end the watch early. It is
   * bounded by the caller's abort signal instead.
   */
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ValidationTrackerOptions) {}

  /** Coalesce the lookups triggered by a burst of incoming events. */
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
   * **`unknown` does not prove forgery.** The relay reports it for any id that
   * has no row: deleted as invalid, deleted by NIP-09, evicted, never ingested,
   * and — because the storage layer answers a read failure by calling
   * everything `unknown` — a broken IndexedDB too. Signature failure is only
   * the most likely of those for an event that was in the cache a moment ago,
   * so what this reports is "the cache no longer holds it", and the caller says
   * exactly that rather than naming a cause it cannot know.
   *
   * `validated` ends the watch: the relay has checked the signature, which is
   * the question actually being asked.
   *
   * An event that never appears at all is reported too, after
   * {@link WATCH_MAX_MISSES} tries. Waiting for a `pending` sighting first would
   * look safer but silently loses the case that matters most: lazy validation
   * runs every 5s and can delete a forged event *before* the first poll, leaving
   * a status that is `unknown` from the outset and a timeline built on it
   * running untouched for the rest of the session.
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
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        void this.refresh();
      }, POLL_INTERVAL_MS);
    }
  }
}
