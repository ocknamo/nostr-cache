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

  describe('getEvents with multiple conditions', () => {
    const events = [
      {
        id: 'event1',
        pubkey: 'author1',
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'test1',
        sig: 'sig1',
      },
      {
        id: 'event2',
        pubkey: 'author1',
        created_at: 2000,
        kind: 1,
        tags: [],
        content: 'test2',
        sig: 'sig2',
      },
      {
        id: 'event3',
        pubkey: 'author2',
        created_at: 1500,
        kind: 2,
        tags: [],
        content: 'test3',
        sig: 'sig3',
      },
    ];

    beforeEach(async () => {
      for (const event of events) {
        await storage.saveEvent(event);
      }
    });

    it('should filter by authors and time range', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1'],
          since: 1500,
          until: 2500,
        },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('event2');
    });

    it('should filter by authors, kinds and time range', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1'],
          kinds: [1],
          since: 500,
          until: 1500,
        },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('event1');
    });

    it('should handle multiple authors with time range', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1', 'author2'],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3']);
    });

    it('should handle multiple kinds with time range', async () => {
      const result = await storage.getEvents([
        {
          kinds: [1, 2],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3']);
    });

    it('should handle multiple authors and kinds with time range', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1', 'author2'],
          kinds: [1, 2],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3']);
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
