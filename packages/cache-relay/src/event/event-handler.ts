/**
 * Event handler for Nostr Cache Relay
 *
 * Handles event processing and storage
 */

import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { SubscriptionManager } from '../core/subscription-manager.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { applyDeletionRequest } from './deletion.js';
import {
  isAddressableKind,
  isDeletionKind,
  isEphemeralKind,
  isReplaceableKind,
} from './event-kind.js';
import { EventValidator } from './event-validator.js';

/** How events are validated as they enter the relay. */
export type ValidateEventsType = 'NONE' | 'IMMEDIATELY' | 'LAZY';

interface Subscription {
  clientId: string;
  id: string;
  filters: Filter[];
  createdAt: number;
}

/**
 * Event handler class
 * Handles event processing and storage
 */
export class EventHandler {
  private validator: EventValidator;

  /**
   * Create a new EventHandler instance
   *
   * @param storage Storage adapter
   * @param subscriptionManager Subscription manager
   * @param validateEventsType How events are validated. Only `IMMEDIATELY`
   *   validates synchronously here; `NONE` / `LAZY` skip (LAZY validation is
   *   performed later by the background validator).
   */
  constructor(
    private storage: StorageAdapter,
    private subscriptionManager: SubscriptionManager,
    private validateEventsType: ValidateEventsType = 'IMMEDIATELY'
  ) {
    this.validator = new EventValidator();
  }

  /**
   * Handle an event
   *
   * @param event Event to handle
   * @returns Promise resolving to object containing success status and matching subscriptions
   */
  async handleEvent(event: NostrEvent): Promise<{
    success: boolean;
    message: string;
    /** Whether the event was persisted (false for ephemeral / not-stored). */
    stored: boolean;
    matches?: Map<string, Subscription[]>;
  }> {
    // Decide whether to validate synchronously now.
    // - IMMEDIATELY: always validate up front.
    // - NONE: never validate.
    // - LAZY: defer validation to the background pass — but deferring only
    //   works for effects the background pass can still undo. Two kinds cannot
    //   wait:
    //   - ephemeral events are never persisted, so there is nothing to delete
    //     after the fact; they would be accepted and broadcast unchecked;
    //   - deletion requests (kind 5) destroy other events on arrival, and no
    //     later pass can bring them back. Verifying the signature late would
    //     let anyone wipe an author's cached events with a forged request.
    const mustValidateNow =
      this.validateEventsType === 'IMMEDIATELY' ||
      (this.validateEventsType === 'LAZY' &&
        (this.isEphemeralEvent(event) || isDeletionKind(event.kind)));
    if (mustValidateNow) {
      try {
        if (!(await this.validator.validate(event))) {
          logger.info('Event validation failed');
          return { success: false, stored: false, message: 'invalid: event validation failed' };
        }
      } catch (error) {
        logger.info('Validation error:', error);
        return {
          success: false,
          stored: false,
          message: 'invalid: validation error',
        };
      }
    }

    // イベントの種類に応じた処理
    if (this.isEphemeralEvent(event)) {
      try {
        // 永続化せずにサブスクリプションマッチングのみ
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, stored: false, message: 'success', matches };
      } catch (error) {
        logger.info('Subscription matching error:', error);
        return {
          success: false,
          stored: false,
          message: 'error: subscription matching failed',
        };
      }
    } else if (this.isReplaceableEvent(event)) {
      try {
        // Replaceableイベントの処理
        // 同じpubkeyとkindの組み合わせに対して最新のものだけ保存
        const stored = await this.handleReplaceableEvent(event);
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, stored, message: 'success', matches };
      } catch (error) {
        logger.info('Replaceable event handling error:', error);
        return {
          success: false,
          stored: false,
          message: 'error: replaceable event handling failed',
        };
      }
    } else if (this.isAddressableEvent(event)) {
      try {
        // Addressableイベントの処理
        // 同じpubkey、kind、dタグ値の組み合わせに対して最新のものだけ保存
        const stored = await this.handleAddressableEvent(event);
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, stored, message: 'success', matches };
      } catch (error) {
        logger.info('Addressable event handling error:', error);
        return {
          success: false,
          stored: false,
          message: 'error: addressable event handling failed',
        };
      }
    } else if (isDeletionKind(event.kind)) {
      try {
        // NIP-09: 削除リクエスト自体を保存してから、参照先の削除を適用する
        const stored = await this.handleDeletionEvent(event);
        if (!stored) {
          logger.info('Event storage failed');
          return { success: false, stored: false, message: 'error: failed to save event' };
        }
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, stored, message: 'success', matches };
      } catch (error) {
        logger.info('Deletion event handling error:', error);
        return {
          success: false,
          stored: false,
          message: 'error: deletion event handling failed',
        };
      }
    }

    // Store the event
    try {
      const saved = await this.storage.saveEvent(event, this.saveOptions());
      if (!saved) {
        logger.info('Event storage failed');
        return { success: false, stored: false, message: 'error: failed to save event' };
      }
    } catch (error) {
      logger.info('Storage error:', error);
      return {
        success: false,
        stored: false,
        message: 'error: storage operation failed',
      };
    }

    // Find matching subscriptions
    try {
      const matches = this.subscriptionManager.findMatchingSubscriptions(event);
      return { success: true, stored: true, message: 'success', matches };
    } catch (error) {
      logger.info('Subscription matching error:', error);
      // The event was persisted above, but matching failed → reported as error.
      return {
        success: false,
        stored: true,
        message: 'error: subscription matching failed',
      };
    }
  }

  /**
   * Save options recording the persisted validation state: only IMMEDIATELY
   * mode has verified the event before it reaches storage. LAZY / NONE save
   * as pending (LAZY's background pass marks them validated later).
   *
   * @private
   */
  private saveOptions(): { validated: boolean } {
    return { validated: this.validateEventsType === 'IMMEDIATELY' };
  }

  /**
   * Check if an event is replaceable
   *
   * @param event Event to check
   * @returns True if the event is replaceable
   * @private
   */
  private isReplaceableEvent(event: NostrEvent): boolean {
    return isReplaceableKind(event.kind);
  }

  /**
   * Check if an event is ephemeral
   *
   * @param event Event to check
   * @returns True if the event is ephemeral
   * @private
   */
  private isEphemeralEvent(event: NostrEvent): boolean {
    return isEphemeralKind(event.kind);
  }

  /**
   * Check if an event is addressable
   *
   * @param event Event to check
   * @returns True if the event is addressable
   * @private
   */
  private isAddressableEvent(event: NostrEvent): boolean {
    return isAddressableKind(event.kind);
  }

  /**
   * Get the d tag value from an event
   *
   * @param event Event to get the d tag from
   * @returns The d tag value, or undefined if not found
   * @private
   */
  private getDTagValue(event: NostrEvent): string | undefined {
    const dTag = event.tags.find((tag) => tag[0] === 'd');
    return dTag ? dTag[1] : undefined;
  }

  /**
   * Handle a replaceable event
   * Deletes older events with the same pubkey and kind
   *
   * @param event Event to handle
   * @returns Promise resolving to boolean indicating success
   * @private
   */
  private async handleReplaceableEvent(event: NostrEvent): Promise<boolean> {
    try {
      // 同じpubkeyとkindの古いイベントを削除
      await this.storage.deleteEventsByPubkeyAndKind(event.pubkey, event.kind);

      // 新しいイベントを保存
      return await this.storage.saveEvent(event, this.saveOptions());
    } catch (error) {
      logger.info('Error handling replaceable event:', error);
      throw error;
    }
  }

  /**
   * Handle an addressable event
   * Deletes older events with the same pubkey, kind, and d tag value
   *
   * @param event Event to handle
   * @returns Promise resolving to boolean indicating success
   * @private
   */
  private async handleAddressableEvent(event: NostrEvent): Promise<boolean> {
    try {
      const dTagValue = this.getDTagValue(event);

      if (dTagValue === undefined) {
        logger.info('Addressable event missing d tag');
        return false;
      }

      // 同じpubkey、kind、dタグ値の古いイベントを削除
      await this.storage.deleteEventsByPubkeyKindAndDTag(event.pubkey, event.kind, dTagValue);

      // 新しいイベントを保存
      return await this.storage.saveEvent(event, this.saveOptions());
    } catch (error) {
      logger.info('Error handling addressable event:', error);
      throw error;
    }
  }

  /**
   * Handle a NIP-09 deletion request (kind 5): store the request, then delete
   * the events it references.
   *
   * The request is stored first and kept indefinitely — clients that have not
   * seen it yet still need it, and keeping it lets the deletion be re-applied
   * whenever the same request arrives again (an upstream echo, a rebroadcast).
   * It cannot delete itself: `parseDeletionRequest` drops `a` tags naming
   * kind 5, and the storage adapter never deletes a kind 5 event by id.
   *
   * A failure while applying the deletion does not fail the event: the request
   * is already persisted, so the next arrival retries it.
   *
   * @param event Deletion request to handle
   * @returns Promise resolving to whether the request itself was stored
   * @private
   */
  private async handleDeletionEvent(event: NostrEvent): Promise<boolean> {
    const stored = await this.storage.saveEvent(event, this.saveOptions());
    if (!stored) {
      return false;
    }

    await applyDeletionRequest(this.storage, event);
    return true;
  }
}
