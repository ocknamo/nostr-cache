/**
 * Tests for EventHandler
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { type Mocked, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionManager } from '../core/subscription-manager.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { EventHandler } from './event-handler.js';
import type { EventValidator } from './event-validator.js';

describe('EventHandler', () => {
  // Mock storage adapter
  const mockStorage = {
    saveEvent: vi.fn().mockResolvedValue(true),
    getEvents: vi.fn().mockResolvedValue([]),
    deleteEvent: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
    deleteEventsByIdsForPubkey: vi.fn().mockResolvedValue(0),
    deleteEventsByAddress: vi.fn().mockResolvedValue(0),
  } as unknown as Mocked<StorageAdapter>;

  // Mock subscription manager
  const mockSubscriptionManager = {
    subscriptions: new Map(),
    clientSubscriptions: new Map(),
    storage: mockStorage,
    createSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    removeAllSubscriptions: vi.fn(),
    removeSubscriptionByIdForAllClients: vi.fn(),
    getSubscription: vi.fn(),
    getClientSubscriptions: vi.fn(),
    getAllSubscriptions: vi.fn(),
    findMatchingSubscriptions: vi.fn().mockReturnValue(new Map()),
    eventMatchesFilter: vi.fn(),
    getSubscriptionKey: vi.fn(),
  } as unknown as Mocked<SubscriptionManager>;

  // Mock event validator
  const mockEventValidator = {
    validate: vi.fn().mockReturnValue(true),
  } as unknown as Mocked<EventValidator>;

  // Sample events
  const regularEvent: NostrEvent = {
    id: '123',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Hello, world!',
    sig: 'xyz',
  };

  const replaceableEvent: NostrEvent = {
    id: '456',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 0, // Replaceable
    tags: [],
    content: '{"name":"John"}',
    sig: 'xyz',
  };

  const ephemeralEvent: NostrEvent = {
    id: '789',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 20001, // Ephemeral
    tags: [],
    content: 'Ephemeral content',
    sig: 'xyz',
  };

  const addressableEvent: NostrEvent = {
    id: '012',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 30001, // Addressable
    tags: [['d', 'address-value']],
    content: 'Addressable content',
    sig: 'xyz',
  };

  let eventHandler: EventHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = new EventHandler(mockStorage, mockSubscriptionManager);
    // @ts-ignore - private field access
    eventHandler.validator = mockEventValidator;
  });

  describe('core event processing', () => {
    beforeEach(() => {
      mockEventValidator.validate.mockResolvedValue(true);
    });

    it('should process regular events correctly', async () => {
      const result = await eventHandler.handleEvent(regularEvent);

      expect(result.success).toBe(true);
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent, { validated: true });
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(regularEvent);
    });

    it('should handle replaceable events', async () => {
      const result = await eventHandler.handleEvent(replaceableEvent);

      expect(result.success).toBe(true);
      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalledWith(
        replaceableEvent.pubkey,
        replaceableEvent.kind
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(replaceableEvent, { validated: true });
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(
        replaceableEvent
      );
    });

    it('should process ephemeral events without storage', async () => {
      const result = await eventHandler.handleEvent(ephemeralEvent);

      expect(result.success).toBe(true);
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(
        ephemeralEvent
      );
    });

    it('should handle addressable events', async () => {
      const result = await eventHandler.handleEvent(addressableEvent);

      expect(result.success).toBe(true);
      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).toHaveBeenCalledWith(
        addressableEvent.pubkey,
        addressableEvent.kind,
        'address-value'
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(addressableEvent, { validated: true });
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(
        addressableEvent
      );
    });

    it('should handle concurrent events', async () => {
      const events = [regularEvent, replaceableEvent, ephemeralEvent];
      const results = await Promise.all(events.map((event) => eventHandler.handleEvent(event)));

      expect(results.every((result) => result.success)).toBe(true);
      expect(mockStorage.saveEvent).toHaveBeenCalledTimes(2); // ephemeralEvent is not stored
    });
  });

  describe('event validation', () => {
    beforeEach(() => {
      mockEventValidator.validate.mockClear();
    });

    it('should validate event structure', async () => {
      await eventHandler.handleEvent(regularEvent);
      expect(mockEventValidator.validate).toHaveBeenCalledWith(regularEvent);
    });

    it('should reject invalid events', async () => {
      mockEventValidator.validate.mockResolvedValueOnce(false);
      const result = await eventHandler.handleEvent(regularEvent);
      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should validate event timestamps', async () => {
      const futureEvent = {
        ...regularEvent,
        created_at: Math.floor(Date.now() / 1000) + 1000, // 1000 seconds in the future
      };
      mockEventValidator.validate.mockResolvedValueOnce(false);
      const result = await eventHandler.handleEvent(futureEvent);
      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle storage errors', async () => {
      mockEventValidator.validate.mockResolvedValue(true);
      mockStorage.saveEvent.mockRejectedValueOnce(new Error('Storage error'));

      const result = await eventHandler.handleEvent(regularEvent);

      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent, { validated: true });
    });

    it('should handle validation errors gracefully', async () => {
      mockEventValidator.validate.mockImplementation(() => {
        throw new Error('Validation error');
      });

      const result = await eventHandler.handleEvent(regularEvent);

      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle subscription matching errors', async () => {
      mockEventValidator.validate.mockResolvedValue(true);
      mockStorage.saveEvent.mockResolvedValue(true);
      mockSubscriptionManager.findMatchingSubscriptions.mockImplementation(() => {
        throw new Error('Subscription error');
      });

      const result = await eventHandler.handleEvent(regularEvent);

      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent, { validated: true });
    });
  });

  describe('event type identification', () => {
    it('should identify replaceable events', () => {
      const result = eventHandler['isReplaceableEvent'](replaceableEvent);
      expect(result).toBe(true);
    });

    it('should identify non-replaceable events', () => {
      const result = eventHandler['isReplaceableEvent'](regularEvent);
      expect(result).toBe(false);
    });

    it('should identify ephemeral events', () => {
      const result = eventHandler['isEphemeralEvent'](ephemeralEvent);
      expect(result).toBe(true);
    });

    it('should identify non-ephemeral events', () => {
      const result = eventHandler['isEphemeralEvent'](regularEvent);
      expect(result).toBe(false);
    });

    it('should identify addressable events', () => {
      const result = eventHandler['isAddressableEvent'](addressableEvent);
      expect(result).toBe(true);
    });

    it('should identify non-addressable events', () => {
      const result = eventHandler['isAddressableEvent'](regularEvent);
      expect(result).toBe(false);
    });
  });

  describe('tag handling', () => {
    it('should get the d tag value', () => {
      const result = eventHandler['getDTagValue'](addressableEvent);
      expect(result).toBe('address-value');
    });

    it('should return undefined if no d tag is present', () => {
      const result = eventHandler['getDTagValue'](regularEvent);
      expect(result).toBeUndefined();
    });

    it('should handle multiple d tags', () => {
      const multiTagEvent = {
        ...addressableEvent,
        tags: [
          ['d', 'first-value'],
          ['d', 'second-value'],
        ],
      };
      const result = eventHandler['getDTagValue'](multiTagEvent);
      expect(result).toBe('first-value');
    });
  });

  describe('handleReplaceableEvent', () => {
    it('should delete old events and save new event', async () => {
      await eventHandler['handleReplaceableEvent'](replaceableEvent, true);

      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalledWith(
        replaceableEvent.pubkey,
        replaceableEvent.kind
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(replaceableEvent, { validated: true });
    });

    it('should handle errors during old event deletion', async () => {
      mockStorage.deleteEventsByPubkeyAndKind.mockRejectedValueOnce(new Error('Delete error'));

      await expect(
        eventHandler['handleReplaceableEvent'](replaceableEvent, true)
      ).rejects.toThrow();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during new event saving', async () => {
      mockStorage.saveEvent.mockRejectedValueOnce(new Error('Save error'));

      await expect(
        eventHandler['handleReplaceableEvent'](replaceableEvent, true)
      ).rejects.toThrow();
      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalled();
    });
  });

  describe('handleAddressableEvent', () => {
    it('should delete old events and save new event', async () => {
      await eventHandler['handleAddressableEvent'](addressableEvent, true);

      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).toHaveBeenCalledWith(
        addressableEvent.pubkey,
        addressableEvent.kind,
        'address-value'
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(addressableEvent, { validated: true });
    });

    it('should fail when d tag is missing', async () => {
      const eventWithoutDTag = {
        ...addressableEvent,
        tags: [],
      };

      const result = await eventHandler['handleAddressableEvent'](eventWithoutDTag, true);

      expect(result).toBe(false);
      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).not.toHaveBeenCalled();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during old event deletion', async () => {
      mockStorage.deleteEventsByPubkeyKindAndDTag.mockRejectedValueOnce(new Error('Delete error'));

      await expect(
        eventHandler['handleAddressableEvent'](addressableEvent, true)
      ).rejects.toThrow();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during new event saving', async () => {
      mockStorage.saveEvent.mockRejectedValueOnce(new Error('Save error'));

      await expect(
        eventHandler['handleAddressableEvent'](addressableEvent, true)
      ).rejects.toThrow();
      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).toHaveBeenCalled();
    });
  });

  describe('deletion requests (NIP-09)', () => {
    const AUTHOR = 'a'.repeat(64);
    const TARGET_ID = '1'.repeat(64);

    const deletionEvent: NostrEvent = {
      id: 'deletion-id',
      pubkey: AUTHOR,
      created_at: 1700000000,
      kind: 5,
      tags: [
        ['e', TARGET_ID],
        ['a', `30023:${AUTHOR}:slug`],
        ['k', '1'],
      ],
      content: 'published by accident',
      sig: 'xyz',
    };

    beforeEach(() => {
      // 先行する describe が差し替えた実装（例外送出）を戻す
      mockEventValidator.validate.mockResolvedValue(true);
      mockStorage.saveEvent.mockResolvedValue(true);
      mockSubscriptionManager.findMatchingSubscriptions.mockReturnValue(new Map());
    });

    it('should store the deletion request and apply it', async () => {
      const result = await eventHandler.handleEvent(deletionEvent);

      expect(result.success).toBe(true);
      expect(result.stored).toBe(true);
      // リクエスト自体は保存する（クライアントへの配信と再適用のため）
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(deletionEvent, { validated: true });
      expect(mockStorage.deleteEventsByIdsForPubkey).toHaveBeenCalledWith([TARGET_ID], AUTHOR);
      expect(mockStorage.deleteEventsByAddress).toHaveBeenCalledWith(
        { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
        deletionEvent.created_at
      );
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(deletionEvent);
    });

    it('should not apply the deletion when the request could not be stored', async () => {
      mockStorage.saveEvent.mockResolvedValueOnce(false);

      const result = await eventHandler.handleEvent(deletionEvent);

      expect(result.success).toBe(false);
      expect(result.stored).toBe(false);
      expect(mockStorage.deleteEventsByIdsForPubkey).not.toHaveBeenCalled();
    });

    it('should still accept the request when applying the deletion fails', async () => {
      // 削除の適用に失敗してもリクエストは保存済みで、再受信時に再適用される
      mockStorage.deleteEventsByIdsForPubkey.mockRejectedValueOnce(new Error('Delete error'));

      const result = await eventHandler.handleEvent(deletionEvent);

      expect(result.success).toBe(true);
      expect(result.stored).toBe(true);
    });

    it('should verify the signature up front even in LAZY mode', async () => {
      // 削除は取り消せないため、LAZY でも同期検証する
      const lazyHandler = new EventHandler(mockStorage, mockSubscriptionManager, 'LAZY');
      // @ts-ignore - private field access
      lazyHandler.validator = mockEventValidator;
      mockEventValidator.validate.mockResolvedValueOnce(false);

      const result = await lazyHandler.handleEvent(deletionEvent);

      expect(mockEventValidator.validate).toHaveBeenCalledWith(deletionEvent);
      expect(result.success).toBe(false);
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
      expect(mockStorage.deleteEventsByIdsForPubkey).not.toHaveBeenCalled();
    });

    it('should not validate regular events up front in LAZY mode', async () => {
      const lazyHandler = new EventHandler(mockStorage, mockSubscriptionManager, 'LAZY');
      // @ts-ignore - private field access
      lazyHandler.validator = mockEventValidator;

      await lazyHandler.handleEvent(regularEvent);

      expect(mockEventValidator.validate).not.toHaveBeenCalled();
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent, { validated: false });
    });
  });
});
