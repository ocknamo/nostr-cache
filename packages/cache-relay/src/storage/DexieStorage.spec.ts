import { NostrEvent } from '@nostr-cache/types';
import 'fake-indexeddb/auto';
import { DexieStorage } from './DexieStorage';

describe('DexieStorage', () => {
  let storage: DexieStorage;

  beforeEach(() => {
    // Reset storage for each test
    storage = new DexieStorage('TestNostrCacheRelay');
  });

  afterEach(async () => {
    await storage.clear();
    // Delete the database
    await storage.delete();
    // Reset indexedDB for next test
    // @ts-ignore - fake-indexeddb types
    indexedDB = new IDBFactory();
  });

  const mockEvent: NostrEvent = {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: 1234567890,
    kind: 1,
    tags: [['p', 'test-pubkey']],
    content: 'test content',
    sig: 'test-sig',
  };

  describe('saveEvent', () => {
    it('should save event successfully', async () => {
      const result = await storage.saveEvent(mockEvent);
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      // Force an error by trying to save an invalid event
      const result = await storage.saveEvent({} as NostrEvent);
      expect(result).toBe(false);
    });
  });

  describe('getEvents', () => {
    beforeEach(async () => {
      await storage.saveEvent(mockEvent);
    });

    it('should get events by id', async () => {
      const events = await storage.getEvents([{ ids: ['test-id'] }]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);
    });

    it('should get events by author', async () => {
      const events = await storage.getEvents([{ authors: ['test-pubkey'] }]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);
    });

    it('should get events by kind', async () => {
      const events = await storage.getEvents([{ kinds: [1] }]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);
    });

    it('should return empty array when no matches', async () => {
      const events = await storage.getEvents([{ ids: ['non-existent'] }]);
      expect(events).toHaveLength(0);
    });

    it('should handle multiple filters', async () => {
      const events = await storage.getEvents([{ ids: ['test-id'] }, { authors: ['test-pubkey'] }]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);
    });

    it('should get events by tags', async () => {
      const events = await storage.getEvents([{ '#p': ['test-pubkey'] }]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);
    });

    it('should return empty array when tag value does not match', async () => {
      const events = await storage.getEvents([{ '#p': ['non-existent'] }]);
      expect(events).toHaveLength(0);
    });
  });

  describe('deleteEvent', () => {
    beforeEach(async () => {
      await storage.saveEvent(mockEvent);
    });

    it('should delete event successfully', async () => {
      const result = await storage.deleteEvent('test-id');
      expect(result).toBe(true);

      const events = await storage.getEvents([{ ids: ['test-id'] }]);
      expect(events).toHaveLength(0);
    });

    it('should return false when event not found', async () => {
      const result = await storage.deleteEvent('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    beforeEach(async () => {
      await storage.saveEvent(mockEvent);
    });

    it('should clear all events', async () => {
      await storage.clear();
      const events = await storage.getEvents([{}]);
      expect(events).toHaveLength(0);
    });
  });
});
