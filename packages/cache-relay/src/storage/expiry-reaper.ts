/**
 * TTL expiry reaper for Nostr Cache Relay
 *
 * Periodically deletes events that have outlived the configured TTL, instead
 * of filtering on every read. This trades exactness (events may be returned
 * for up to one sweep interval past expiry) for cheaper reads and proactive
 * reclamation of storage.
 */

import { logger } from '@nostr-cache/shared';
import type { StorageAdapter } from './storage-adapter.js';

/** Default interval between TTL sweeps, in seconds. */
export const DEFAULT_TTL_SWEEP_INTERVAL = 60;

/**
 * Options controlling the TTL sweep.
 */
export interface ExpiryReaperOptions {
  /** Events older than this many seconds (by `created_at`) are deleted. */
  ttlSeconds: number;
  /** Interval between sweeps, in seconds. Defaults to 60. */
  intervalSeconds?: number;
  /** Clock injection for testing (returns current unix time in seconds). */
  now?: () => number;
}

/**
 * Periodically purges expired events from storage on a timer.
 */
export class ExpiryReaper {
  private readonly ttlSeconds: number;
  private readonly intervalSeconds: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping sweeps. */
  private sweeping = false;
  /** Ensures the "storage does not support deleteExpired" warning logs once. */
  private unsupportedWarned = false;

  /**
   * @param storage Storage adapter to purge from (must implement deleteExpired)
   * @param options Sweep configuration
   */
  constructor(
    private readonly storage: StorageAdapter,
    options: ExpiryReaperOptions
  ) {
    this.ttlSeconds = options.ttlSeconds;
    this.intervalSeconds =
      options.intervalSeconds && options.intervalSeconds > 0
        ? options.intervalSeconds
        : DEFAULT_TTL_SWEEP_INTERVAL;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Start the periodic sweep. Runs an immediate sweep, then on the interval.
   * Idempotent.
   */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    // Kick an immediate sweep to clear any backlog at startup
    this.runSweep();

    this.timer = setInterval(() => {
      this.runSweep();
    }, this.intervalSeconds * 1000);

    // Don't keep the Node.js event loop alive solely for this timer
    this.timer.unref?.();
  }

  /**
   * Stop the periodic sweep. Idempotent.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Delete events older than `now - ttl`.
   *
   * @returns Promise resolving to the number of events deleted
   */
  async sweep(): Promise<number> {
    if (this.ttlSeconds <= 0) {
      return 0;
    }

    if (typeof this.storage.deleteExpired !== 'function') {
      if (!this.unsupportedWarned) {
        logger.warn('TTL is configured but the storage adapter does not support deleteExpired');
        this.unsupportedWarned = true;
      }
      return 0;
    }

    const threshold = this.now() - this.ttlSeconds;
    const removed = await this.storage.deleteExpired(threshold);
    if (removed > 0) {
      logger.info(`TTL sweep removed ${removed} expired events (older than ${threshold})`);
    }
    return removed;
  }

  /**
   * Run a sweep without overlapping a previous one, swallowing errors.
   *
   * @private
   */
  private runSweep(): void {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    this.sweep()
      .catch((error) => {
        logger.error('TTL sweep failed:', error);
      })
      .finally(() => {
        this.sweeping = false;
      });
  }
}
