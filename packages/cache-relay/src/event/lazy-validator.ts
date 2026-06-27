/**
 * Lazy event validator for Nostr Cache Relay
 *
 * Defers event validation: events are accepted and stored immediately, then
 * validated asynchronously in batches on a timer. Events that fail validation
 * are removed from storage.
 */

import { logger } from '@nostr-cache/shared';
import type { NostrEvent } from '@nostr-cache/shared';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { EventValidator } from './event-validator.js';

/** Default interval between validation passes, in seconds. */
export const DEFAULT_LAZY_VALIDATE_INTERVAL = 60;

/** Default number of events validated per pass. */
export const DEFAULT_LAZY_VALIDATE_BATCH_SIZE = 100;

/**
 * Default upper bound on the pending-validation queue. When exceeded, the
 * oldest queued events are dropped (they remain stored but unvalidated) to
 * bound memory use.
 */
export const DEFAULT_LAZY_VALIDATE_MAX_QUEUE_SIZE = 10_000;

/**
 * Options controlling the lazy validation cadence.
 */
export interface LazyValidatorOptions {
  /** Interval between validation passes, in seconds. */
  intervalSeconds?: number;
  /** Maximum number of events validated per pass. */
  batchSize?: number;
  /** Upper bound on the pending-validation queue (drops oldest when exceeded). */
  maxQueueSize?: number;
}

/**
 * Validates queued events in the background and evicts invalid ones.
 */
export class LazyValidator {
  private readonly validator: EventValidator;
  private readonly intervalSeconds: number;
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private queue: NostrEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping validation passes from the timer. */
  private processing = false;

  /**
   * @param storage Storage adapter used to evict invalid events
   * @param options Validation cadence options
   * @param validator Event validator (injectable for testing)
   */
  constructor(
    private readonly storage: StorageAdapter,
    options: LazyValidatorOptions = {},
    validator: EventValidator = new EventValidator()
  ) {
    this.validator = validator;
    this.intervalSeconds =
      options.intervalSeconds && options.intervalSeconds > 0
        ? options.intervalSeconds
        : DEFAULT_LAZY_VALIDATE_INTERVAL;
    this.batchSize =
      options.batchSize && options.batchSize > 0
        ? options.batchSize
        : DEFAULT_LAZY_VALIDATE_BATCH_SIZE;
    this.maxQueueSize =
      options.maxQueueSize && options.maxQueueSize > 0
        ? options.maxQueueSize
        : DEFAULT_LAZY_VALIDATE_MAX_QUEUE_SIZE;
  }

  /**
   * Queue an already-stored event for later validation.
   *
   * @param event Event to validate on a subsequent pass
   */
  enqueue(event: NostrEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      // Drop the oldest queued event to bound memory. It stays in storage but
      // unvalidated; this is the documented best-effort nature of LAZY mode.
      const dropped = this.queue.shift();
      logger.warn(
        `Lazy validation queue full (${this.maxQueueSize}); dropping unvalidated event ${dropped?.id}`
      );
    }
    this.queue.push(event);
  }

  /**
   * Number of events still awaiting validation.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Start the periodic validation timer. Idempotent.
   */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      // Skip if a previous pass is still running to avoid overlapping passes
      if (this.processing) {
        return;
      }
      this.processing = true;
      // Errors are handled inside processBatch; guard against unhandled rejections
      this.processBatch()
        .catch((error) => {
          logger.error('Lazy validation pass failed:', error);
        })
        .finally(() => {
          this.processing = false;
        });
    }, this.intervalSeconds * 1000);

    // Avoid keeping the Node.js event loop alive solely for this timer
    this.timer.unref?.();
  }

  /**
   * Stop the periodic validation timer. Idempotent.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Validate and drain all currently queued events.
   *
   * Intended to be called on shutdown (after {@link stop}) so that pending
   * events are not silently discarded with the in-memory queue.
   *
   * @returns Total number of events removed from storage
   */
  async flush(): Promise<number> {
    let total = 0;
    while (this.queue.length > 0) {
      total += await this.processBatch();
    }
    return total;
  }

  /**
   * Validate up to `batchSize` queued events, deleting any that are invalid.
   *
   * @returns Number of events removed from storage in this pass
   */
  async processBatch(): Promise<number> {
    const batch = this.queue.splice(0, this.batchSize);
    let removed = 0;

    for (const event of batch) {
      let valid = false;
      try {
        valid = await this.validator.validate(event);
      } catch (error) {
        logger.error(`Lazy validation threw for event ${event.id}:`, error);
        valid = false;
      }

      if (!valid) {
        try {
          const deleted = await this.storage.deleteEvent(event.id);
          if (deleted) {
            removed++;
            logger.warn(`Lazy validation removed invalid event ${event.id}`);
          }
        } catch (error) {
          logger.error(`Failed to remove invalid event ${event.id}:`, error);
        }
      }
    }

    return removed;
  }
}
