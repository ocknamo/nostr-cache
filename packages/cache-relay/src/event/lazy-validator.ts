/**
 * Lazy event validator for Nostr Cache Relay
 *
 * Defers event validation: events are accepted and stored immediately (as
 * pending), then validated asynchronously in batches on a timer. The pending
 * queue lives in storage itself (the `validated` column), so it survives
 * reloads/crashes and needs no in-memory bound: on start the validator simply
 * resumes draining whatever is still unvalidated. Events that fail validation
 * are removed from storage; events that pass are marked validated.
 */

import { logger } from '@nostr-cache/shared';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { EventValidator } from './event-validator.js';

/** Default interval between validation passes, in seconds. */
export const DEFAULT_LAZY_VALIDATE_INTERVAL = 60;

/** Default number of events validated per pass. */
export const DEFAULT_LAZY_VALIDATE_BATCH_SIZE = 100;

/**
 * Options controlling the lazy validation cadence.
 */
export interface LazyValidatorOptions {
  /** Interval between validation passes, in seconds. */
  intervalSeconds?: number;
  /** Maximum number of events validated per pass. */
  batchSize?: number;
}

/**
 * Result of a single validation pass.
 */
export interface LazyValidationPassResult {
  /** Number of events verified and marked validated in this pass. */
  validated: number;
  /** Number of invalid events removed from storage in this pass. */
  removed: number;
}

/**
 * Validates pending (unvalidated) stored events in the background, marking
 * valid ones and evicting invalid ones. Storage is the queue.
 */
export class LazyValidator {
  private readonly validator: EventValidator;
  private readonly intervalSeconds: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping validation passes. */
  private processing = false;

  /**
   * @param storage Storage adapter holding the pending events and receiving
   *   the validation results
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
  }

  /**
   * Start the periodic validation timer and kick one immediate pass so
   * events left pending by a previous session (reload/crash) are picked up
   * without waiting a full interval. Idempotent.
   */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      this.runGuardedPass();
    }, this.intervalSeconds * 1000);

    // Avoid keeping the Node.js event loop alive solely for this timer
    this.timer.unref?.();

    // 前セッションからの持ち越し分（リロード復帰）を即座に処理し始める
    this.runGuardedPass();
  }

  /**
   * Run one validation pass unless another is still in flight.
   *
   * @private
   */
  private runGuardedPass(): void {
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
  }

  /**
   * Stop the periodic validation timer. Idempotent. Any still-pending events
   * remain marked unvalidated in storage and are resumed on the next start.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Validate up to `batchSize` pending events from storage, marking the valid
   * ones and deleting the invalid ones.
   *
   * @returns Counts of events validated and removed in this pass
   */
  async processBatch(): Promise<LazyValidationPassResult> {
    const batch = await this.storage.getUnvalidatedEvents(this.batchSize);
    const validIds: string[] = [];
    let removed = 0;

    for (const event of batch) {
      let valid = false;
      try {
        valid = await this.validator.validate(event);
      } catch (error) {
        logger.error(`Lazy validation threw for event ${event.id}:`, error);
        valid = false;
      }

      if (valid) {
        validIds.push(event.id);
      } else {
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

    if (validIds.length > 0) {
      try {
        await this.storage.markValidated(validIds);
      } catch (error) {
        // 失敗しても pending のまま残るだけで、次のパスで再検証される
        logger.error('Failed to mark events validated:', error);
        return { validated: 0, removed };
      }
    }

    return { validated: validIds.length, removed };
  }
}
