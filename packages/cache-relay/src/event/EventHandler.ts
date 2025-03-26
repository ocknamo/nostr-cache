/**
 * Event handler for Nostr Cache Relay
 *
 * Handles event processing and storage
 */

import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/types';
import type { SubscriptionManager } from '../core/SubscriptionManager';
import type { StorageAdapter } from '../storage/StorageAdapter';
import { EventValidator } from './EventValidator';

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
   */
  constructor(
    private storage: StorageAdapter,
    private subscriptionManager: SubscriptionManager
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
    matches?: Map<string, Subscription[]>;
  }> {
    // Validate the event
    try {
      if (!(await this.validator.validate(event))) {
        logger.info('Event validation failed');
        return { success: false, message: 'invalid: event validation failed' };
      }
    } catch (error) {
      logger.info('Validation error:', error);
      return {
        success: false,
        message: 'invalid: validation error',
      };
    }

    // イベントの種類に応じた処理
    if (this.isEphemeralEvent(event)) {
      try {
        // 永続化せずにサブスクリプションマッチングのみ
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, message: 'success', matches };
      } catch (error) {
        logger.info('Subscription matching error:', error);
        return {
          success: false,
          message: 'error: subscription matching failed',
        };
      }
    } else if (this.isReplaceableEvent(event)) {
      try {
        // Replaceableイベントの処理
        // 同じpubkeyとkindの組み合わせに対して最新のものだけ保存
        await this.handleReplaceableEvent(event);
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, message: 'success', matches };
      } catch (error) {
        logger.info('Replaceable event handling error:', error);
        return {
          success: false,
          message: 'error: replaceable event handling failed',
        };
      }
    } else if (this.isAddressableEvent(event)) {
      try {
        // Addressableイベントの処理
        // 同じpubkey、kind、dタグ値の組み合わせに対して最新のものだけ保存
        await this.handleAddressableEvent(event);
        const matches = this.subscriptionManager.findMatchingSubscriptions(event);
        return { success: true, message: 'success', matches };
      } catch (error) {
        logger.info('Addressable event handling error:', error);
        return {
          success: false,
          message: 'error: addressable event handling failed',
        };
      }
    }

    // Store the event
    try {
      const saved = await this.storage.saveEvent(event);
      if (!saved) {
        logger.info('Event storage failed');
        return { success: false, message: 'error: failed to save event' };
      }
    } catch (error) {
      logger.info('Storage error:', error);
      return {
        success: false,
        message: 'error: storage operation failed',
      };
    }

    // Find matching subscriptions
    try {
      const matches = this.subscriptionManager.findMatchingSubscriptions(event);
      return { success: true, message: 'success', matches };
    } catch (error) {
      logger.info('Subscription matching error:', error);
      return {
        success: false,
        message: 'error: subscription matching failed',
      };
    }
  }

  /**
   * Check if an event is replaceable
   *
   * @param event Event to check
   * @returns True if the event is replaceable
   * @private
   */
  private isReplaceableEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
  }

  /**
   * Check if an event is ephemeral
   *
   * @param event Event to check
   * @returns True if the event is ephemeral
   * @private
   */
  private isEphemeralEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return kind >= 20000 && kind < 30000;
  }

  /**
   * Check if an event is addressable
   *
   * @param event Event to check
   * @returns True if the event is addressable
   * @private
   */
  private isAddressableEvent(event: NostrEvent): boolean {
    const kind = event.kind;
    return kind >= 30000 && kind < 40000;
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
      return await this.storage.saveEvent(event);
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
      return await this.storage.saveEvent(event);
    } catch (error) {
      logger.info('Error handling addressable event:', error);
      throw error;
    }
  }
}
