/**
 * Tests for EventHandler
 */

import type { NostrEvent } from '@nostr-cache/types';
import type { SubscriptionManager } from '../core/subscription-manager.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { EventHandler } from './event-handler.js';
import type { EventValidator } from './event-validator.js';

describe('EventHandler', () => {
  // Mock storage adapter
  const mockStorage = {
    saveEvent: jest.fn().mockResolvedValue(true),
    getEvents: jest.fn().mockResolvedValue([]),
    deleteEvent: jest.fn().mockResolvedValue(true),
    clear: jest.fn().mockResolvedValue(undefined),
    deleteEventsByPubkeyAndKind: jest.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: jest.fn().mockResolvedValue(true),
  } as jest.Mocked<StorageAdapter>;

  // Mock subscription manager
  const mockSubscriptionManager = {
    subscriptions: new Map(),
    clientSubscriptions: new Map(),
    storage: mockStorage,
    createSubscription: jest.fn(),
    removeSubscription: jest.fn(),
    removeAllSubscriptions: jest.fn(),
    removeSubscriptionByIdForAllClients: jest.fn(),
    getSubscription: jest.fn(),
    getClientSubscriptions: jest.fn(),
    getAllSubscriptions: jest.fn(),
    findMatchingSubscriptions: jest.fn().mockReturnValue(new Map()),
    eventMatchesFilter: jest.fn(),
    getSubscriptionKey: jest.fn(),
  } as unknown as jest.Mocked<SubscriptionManager>;

  // Mock event validator
  const mockEventValidator = {
    validate: jest.fn().mockReturnValue(true),
  } as jest.Mocked<EventValidator>;

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
    jest.clearAllMocks();
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
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent);
      expect(mockSubscriptionManager.findMatchingSubscriptions).toHaveBeenCalledWith(regularEvent);
    });

    it('should handle replaceable events', async () => {
      const result = await eventHandler.handleEvent(replaceableEvent);

      expect(result.success).toBe(true);
      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalledWith(
        replaceableEvent.pubkey,
        replaceableEvent.kind
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(replaceableEvent);
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
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(addressableEvent);
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
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent);
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
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(regularEvent);
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
      await eventHandler['handleReplaceableEvent'](replaceableEvent);

      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalledWith(
        replaceableEvent.pubkey,
        replaceableEvent.kind
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(replaceableEvent);
    });

    it('should handle errors during old event deletion', async () => {
      mockStorage.deleteEventsByPubkeyAndKind.mockRejectedValueOnce(new Error('Delete error'));

      await expect(eventHandler['handleReplaceableEvent'](replaceableEvent)).rejects.toThrow();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during new event saving', async () => {
      mockStorage.saveEvent.mockRejectedValueOnce(new Error('Save error'));

      await expect(eventHandler['handleReplaceableEvent'](replaceableEvent)).rejects.toThrow();
      expect(mockStorage.deleteEventsByPubkeyAndKind).toHaveBeenCalled();
    });
  });

  describe('handleAddressableEvent', () => {
    it('should delete old events and save new event', async () => {
      await eventHandler['handleAddressableEvent'](addressableEvent);

      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).toHaveBeenCalledWith(
        addressableEvent.pubkey,
        addressableEvent.kind,
        'address-value'
      );
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(addressableEvent);
    });

    it('should fail when d tag is missing', async () => {
      const eventWithoutDTag = {
        ...addressableEvent,
        tags: [],
      };

      const result = await eventHandler['handleAddressableEvent'](eventWithoutDTag);

      expect(result).toBe(false);
      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).not.toHaveBeenCalled();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during old event deletion', async () => {
      mockStorage.deleteEventsByPubkeyKindAndDTag.mockRejectedValueOnce(new Error('Delete error'));

      await expect(eventHandler['handleAddressableEvent'](addressableEvent)).rejects.toThrow();
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during new event saving', async () => {
      mockStorage.saveEvent.mockRejectedValueOnce(new Error('Save error'));

      await expect(eventHandler['handleAddressableEvent'](addressableEvent)).rejects.toThrow();
      expect(mockStorage.deleteEventsByPubkeyKindAndDTag).toHaveBeenCalled();
    });
  });
});
