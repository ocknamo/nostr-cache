import { logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { SubscriptionManager } from '../core/subscription-manager.js';
import type { EventAddress, StorageAdapter } from '../storage/storage-adapter.js';
import { applyDeletionRequest } from './deletion.js';
import {
  isAddressableKind,
  isDeletionKind,
  isEphemeralKind,
  isReplaceableKind,
} from './event-kind.js';
import { EventValidator } from './event-validator.js';
import { addressOf, getDTagValue, supersedes } from './replaceable.js';

/** How events are validated as they enter the relay. */
export type ValidateEventsType = 'NONE' | 'IMMEDIATELY' | 'LAZY';

interface Subscription {
  clientId: string;
  id: string;
  filters: Filter[];
  createdAt: number;
}

/**
 * OK message returned for an event the relay accepts but drops because it
 * already holds a newer version of the same replaceable / addressable event.
 * `duplicate:` is NIP-01's machine-readable prefix for "the relay's state
 * already covers this event"; it is sent with `OK true`, since nothing about
 * the event is wrong — it simply lost the NIP-01 version comparison.
 */
const SUPERSEDED_MESSAGE = 'duplicate: a newer version of this event is already stored';

/** Outcome of storing one replaceable / addressable event. */
interface ReplaceOutcome {
  /** Whether the event was persisted. */
  stored: boolean;
  /** Whether it was dropped in favour of a newer stored version. */
  superseded: boolean;
}

/** Result of handling one event. */
export interface HandleEventResult {
  /** Whether the event was accepted (OK true). */
  success: boolean;
  /** OK message; `'success'` when there is nothing to report. */
  message: string;
  /** Whether the event was persisted (false for ephemeral / not-stored). */
  stored: boolean;
  /**
   * Whether the event lost the NIP-01 version comparison against the version
   * already stored at its coordinate. Such an event is accepted but neither
   * stored nor delivered — broadcasting it would push a version the relay
   * itself refuses to keep.
   */
  superseded?: boolean;
  /** Subscriptions the event must be broadcast to, by client id. */
  matches?: Map<string, Subscription[]>;
}

export class EventHandler {
  private validator: EventValidator;

  /**
   * Only `IMMEDIATELY` validates synchronously here; `NONE` / `LAZY` skip
   * (LAZY validation is performed later by the background validator).
   */
  constructor(
    private storage: StorageAdapter,
    private subscriptionManager: SubscriptionManager,
    private validateEventsType: ValidateEventsType = 'IMMEDIATELY'
  ) {
    this.validator = new EventValidator();
  }

  async handleEvent(event: NostrEvent): Promise<HandleEventResult> {
    const mustValidateNow = this.mustValidateNow(event);
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
        const { stored, superseded } = await this.handleReplaceableEvent(event, mustValidateNow);
        if (superseded) {
          return this.supersededResult();
        }
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
        const { stored, superseded } = await this.handleAddressableEvent(event, mustValidateNow);
        if (superseded) {
          return this.supersededResult();
        }
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
        const stored = await this.handleDeletionEvent(event, mustValidateNow);
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

    try {
      const saved = await this.storage.saveEvent(event, this.saveOptions(mustValidateNow));
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
   * Whether this event's signature must be verified before it takes effect.
   *
   * - `IMMEDIATELY`: always verify up front.
   * - `LAZY`: defer to the background pass — but deferring only works for
   *   effects that pass can still undo, so ephemeral events are verified now
   *   (they are never persisted, so there is nothing to delete afterwards).
   * - Deletion requests (kind 5) are verified in **every** mode, `NONE`
   *   included. They destroy other events on arrival and nothing can bring
   *   those back, so accepting one unverified would let any client wipe any
   *   author's cached events. `NONE` opting out of validation means "store
   *   what I send without checking", not "let anyone delete other people's
   *   data"; one signature check per deletion request is a negligible price
   *   for keeping that distinction.
   */
  private mustValidateNow(event: NostrEvent): boolean {
    if (isDeletionKind(event.kind)) {
      return true;
    }
    if (this.validateEventsType === 'IMMEDIATELY') {
      return true;
    }
    return this.validateEventsType === 'LAZY' && this.isEphemeralEvent(event);
  }

  /**
   * Save options recording the persisted validation state.
   *
   * Events verified on the way in are stored as validated; the rest are stored
   * as pending (LAZY's background pass marks them validated later). This
   * follows the actual check rather than the configured mode, so a kind 5
   * verified under LAZY / NONE is not re-queued for verification it already
   * passed.
   */
  private saveOptions(verified: boolean): { validated: boolean } {
    return { validated: verified };
  }

  private isReplaceableEvent(event: NostrEvent): boolean {
    return isReplaceableKind(event.kind);
  }

  private isEphemeralEvent(event: NostrEvent): boolean {
    return isEphemeralKind(event.kind);
  }

  private isAddressableEvent(event: NostrEvent): boolean {
    return isAddressableKind(event.kind);
  }

  private getDTagValue(event: NostrEvent): string | undefined {
    return getDTagValue(event.tags);
  }

  /**
   * Result for an event the relay accepts but drops because it already holds a
   * newer version of the same coordinate. No `matches`: the event must not be
   * broadcast, since the relay itself refuses to keep it.
   */
  private supersededResult(): HandleEventResult {
    return { success: true, stored: false, superseded: true, message: SUPERSEDED_MESSAGE };
  }

  /**
   * Whether the version already stored at `event`'s coordinate wins over
   * `event`, per NIP-01 (newer `created_at`, ties broken by the lowest id).
   *
   * Without this check any older signed event would overwrite the newest one —
   * a replayed copy of a stale profile is enough — because storing a
   * replaceable event deletes every other version of the coordinate first.
   *
   * The lookup and the delete + save that follow it are separate awaits, so two
   * events for the same coordinate handled concurrently can still interleave and
   * leave the older one stored. That race is inherent in the delete-then-save
   * shape this predates; the fix here removes the case that needs no
   * concurrency at all.
   */
  private async isSuperseded(event: NostrEvent, address: EventAddress): Promise<boolean> {
    const current = await this.storage.getCurrentVersion(address);
    if (current === undefined || !supersedes(current, event)) {
      return false;
    }
    logger.info(
      `Dropped ${event.id} (kind ${event.kind}): a newer version (${current.id}) is already stored`
    );
    return true;
  }

  /** Keeps only the newest event with the same pubkey and kind. */
  private async handleReplaceableEvent(
    event: NostrEvent,
    verified: boolean
  ): Promise<ReplaceOutcome> {
    try {
      // 既存版のほうが新しければ保存しない（NIP-01: 最新の1件だけを保持する）
      if (await this.isSuperseded(event, addressOf(event))) {
        return { stored: false, superseded: true };
      }

      await this.storage.deleteEventsByPubkeyAndKind(event.pubkey, event.kind);
      const stored = await this.storage.saveEvent(event, this.saveOptions(verified));
      return { stored, superseded: false };
    } catch (error) {
      logger.info('Error handling replaceable event:', error);
      throw error;
    }
  }

  /** Keeps only the newest event with the same pubkey, kind and d tag value. */
  private async handleAddressableEvent(
    event: NostrEvent,
    verified: boolean
  ): Promise<ReplaceOutcome> {
    try {
      const dTagValue = this.getDTagValue(event);

      if (dTagValue === undefined) {
        logger.info('Addressable event missing d tag');
        return { stored: false, superseded: false };
      }

      // 既存版のほうが新しければ保存しない（NIP-01: 最新の1件だけを保持する）。
      // 座標は addressOf が組み立てる（アドレサブル kind では identifier =
      // dTagValue になる）ので、置換可能側と同じ 1 か所の定義を通す
      if (await this.isSuperseded(event, addressOf(event))) {
        return { stored: false, superseded: true };
      }

      await this.storage.deleteEventsByPubkeyKindAndDTag(event.pubkey, event.kind, dTagValue);
      const stored = await this.storage.saveEvent(event, this.saveOptions(verified));
      return { stored, superseded: false };
    } catch (error) {
      logger.info('Error handling addressable event:', error);
      throw error;
    }
  }

  /**
   * Handle a NIP-09 deletion request (kind 5): store the request, then delete
   * the events it references.
   *
   * The request is stored first, and stored durably: clients that have not
   * seen it yet still need it, and keeping it lets the deletion be re-applied
   * whenever the same request arrives again (an upstream echo, a rebroadcast).
   * That is why kind 5 is exempt from the TTL sweep and evicted last under
   * `storageMaxSize` (see `storage/priority.ts`). It cannot delete itself:
   * `parseDeletionRequest` drops `a` tags naming kind 5, and the storage
   * adapter never deletes a kind 5 event by id.
   *
   * A failure while applying the deletion does not fail the event: the request
   * is already persisted, so the next arrival retries it.
   */
  private async handleDeletionEvent(event: NostrEvent, verified: boolean): Promise<boolean> {
    const stored = await this.storage.saveEvent(event, this.saveOptions(verified));
    if (!stored) {
      return false;
    }

    await applyDeletionRequest(this.storage, event);
    return true;
  }
}
