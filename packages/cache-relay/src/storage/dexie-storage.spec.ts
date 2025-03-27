import type { NostrEvent } from '@nostr-cache/types';
import 'fake-indexeddb/auto';
import { DexieStorage } from './dexie-storage.js';

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
    // biome-ignore lint/suspicious/noGlobalAssign: for indexedDB mock
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

  describe('deleteEventsByPubkeyAndKind', () => {
    const replaceableEvents = [
      {
        id: 'event1',
        pubkey: 'author1',
        created_at: 1000,
        kind: 0, // Replaceable kind
        tags: [],
        content: 'test1',
        sig: 'sig1',
      },
      {
        id: 'event2',
        pubkey: 'author1',
        created_at: 2000,
        kind: 0, // Same author and kind
        tags: [],
        content: 'test2',
        sig: 'sig2',
      },
      {
        id: 'event3',
        pubkey: 'author2',
        created_at: 1500,
        kind: 0, // Different author, same kind
        tags: [],
        content: 'test3',
        sig: 'sig3',
      },
      {
        id: 'event4',
        pubkey: 'author1',
        created_at: 3000,
        kind: 1, // Same author, different kind
        tags: [],
        content: 'test4',
        sig: 'sig4',
      },
    ];

    beforeEach(async () => {
      for (const event of replaceableEvents) {
        await storage.saveEvent(event);
      }
    });

    it('should delete events with matching pubkey and kind', async () => {
      const result = await storage.deleteEventsByPubkeyAndKind('author1', 0);
      expect(result).toBe(true);

      // 特定のpubkeyとkindのイベントが削除されていることを確認
      const events = await storage.getEvents([{ authors: ['author1'], kinds: [0] }]);
      expect(events).toHaveLength(0);

      // 他のイベントは残っていることを確認
      const otherEvents = await storage.getEvents([{}]);
      expect(otherEvents).toHaveLength(2);
      expect(otherEvents.map((e) => e.id).sort()).toEqual(['event3', 'event4']);
    });

    it('should return false when no events match', async () => {
      const result = await storage.deleteEventsByPubkeyAndKind('non-existent', 999);
      expect(result).toBe(false);

      // すべてのイベントが残っていることを確認
      const events = await storage.getEvents([{}]);
      expect(events).toHaveLength(4);
    });

    it('should handle error gracefully', async () => {
      // IndexedDBがロックされていることをシミュレート
      // @ts-ignore - private field access for testing
      jest.spyOn(storage.events, 'where').mockImplementationOnce(() => {
        throw new Error('Database is locked');
      });

      const result = await storage.deleteEventsByPubkeyAndKind('author1', 0);
      expect(result).toBe(false);
    });
  });

  describe('deleteEventsByPubkeyKindAndDTag', () => {
    const addressableEvents = [
      {
        id: 'addr1',
        pubkey: 'author1',
        created_at: 1000,
        kind: 30001, // Addressable kind
        tags: [['d', 'test1']],
        content: 'addr content 1',
        sig: 'sig1',
      },
      {
        id: 'addr2',
        pubkey: 'author1',
        created_at: 2000,
        kind: 30001, // Same author and kind
        tags: [['d', 'test1']], // Same d tag
        content: 'addr content 2',
        sig: 'sig2',
      },
      {
        id: 'addr3',
        pubkey: 'author1',
        created_at: 3000,
        kind: 30001, // Same author and kind
        tags: [['d', 'test2']], // Different d tag
        content: 'addr content 3',
        sig: 'sig3',
      },
      {
        id: 'addr4',
        pubkey: 'author2',
        created_at: 4000,
        kind: 30001, // Different author, same kind
        tags: [['d', 'test1']], // Same d tag
        content: 'addr content 4',
        sig: 'sig4',
      },
      {
        id: 'addr5',
        pubkey: 'author1',
        created_at: 5000,
        kind: 30002, // Same author, different kind
        tags: [['d', 'test1']], // Same d tag
        content: 'addr content 5',
        sig: 'sig5',
      },
      {
        id: 'addr6',
        pubkey: 'author1',
        created_at: 6000,
        kind: 30001, // Same author and kind
        tags: [
          ['d', 'test1'],
          ['e', 'event1'],
        ], // Same d tag with additional tags
        content: 'addr content 6',
        sig: 'sig6',
      },
      {
        id: 'addr7',
        pubkey: 'author1',
        created_at: 7000,
        kind: 30001, // Same author and kind
        tags: [
          ['e', 'event1'],
          ['d', 'test1'],
        ], // Same d tag but different order
        content: 'addr content 7',
        sig: 'sig7',
      },
    ];

    beforeEach(async () => {
      for (const event of addressableEvents) {
        await storage.saveEvent(event);
      }
    });

    it('should delete events with matching pubkey, kind and d tag', async () => {
      const result = await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');
      expect(result).toBe(true);

      // pubkey, kind, d tagが一致するイベントが削除されていることを確認
      const remainingEvents = await storage.getEvents([{}]);
      expect(remainingEvents).toHaveLength(3);
      expect(remainingEvents.map((e) => e.id).sort()).toEqual(['addr3', 'addr4', 'addr5']);
    });

    it('should delete events regardless of tag position', async () => {
      // addr7はdタグの位置が異なるが、削除されるべき
      await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');

      const event = await storage.getEvents([{ ids: ['addr7'] }]);
      expect(event).toHaveLength(0);
    });

    it('should not delete events with different d tag values', async () => {
      await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');

      const events = await storage.getEvents([{ kinds: [30001], '#d': ['test2'] }]);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('addr3');
    });

    it('should return false when no events match', async () => {
      const result = await storage.deleteEventsByPubkeyKindAndDTag(
        'non-existent',
        999,
        'non-existent'
      );
      expect(result).toBe(false);

      // すべてのイベントが残っていることを確認
      const events = await storage.getEvents([{}]);
      expect(events).toHaveLength(7);
    });

    it('should handle error gracefully', async () => {
      // IndexedDBがロックされていることをシミュレート
      // @ts-ignore - private field access for testing
      jest.spyOn(storage.events, 'where').mockImplementationOnce(() => {
        throw new Error('Database is locked');
      });

      const result = await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');
      expect(result).toBe(false);
    });
  });

  describe('Additional getEvents Patterns', () => {
    const events = [
      {
        id: 'event1',
        pubkey: 'author1',
        created_at: 1000,
        kind: 1,
        tags: [
          ['p', 'user1'],
          ['e', 'event1'],
        ],
        content: 'test1',
        sig: 'sig1',
      },
      {
        id: 'event2',
        pubkey: 'author2',
        created_at: 2000,
        kind: 2,
        tags: [
          ['p', 'user2'],
          ['e', 'event2'],
        ],
        content: 'test2',
        sig: 'sig2',
      },
      {
        id: 'event3',
        pubkey: 'author3',
        created_at: 3000,
        kind: 3,
        tags: [
          ['p', 'user1'],
          ['e', 'event1'],
        ],
        content: 'test3',
        sig: 'sig3',
      },
      {
        id: 'event4',
        pubkey: 'author4',
        created_at: 4000,
        kind: 4,
        tags: [
          ['p', 'user2'],
          ['e', 'event2'],
        ],
        content: 'test4',
        sig: 'sig4',
      },
      {
        id: 'event5',
        pubkey: 'author5',
        created_at: 5000,
        kind: 5,
        tags: [
          ['p', 'user1'],
          ['e', 'event1'],
        ],
        content: 'test5',
        sig: 'sig5',
      },
    ];

    beforeEach(async () => {
      for (const event of events) {
        await storage.saveEvent(event);
      }
    });

    it('should respect limit parameter', async () => {
      const result = await storage.getEvents([{ limit: 3 }]);
      expect(result).toHaveLength(3);
    });

    it('should respect limit parameter with other filters', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1', 'author2', 'author3', 'author4', 'author5'],
          limit: 2,
        },
      ]);
      expect(result).toHaveLength(2);
    });

    it('should filter by time range only', async () => {
      const result = await storage.getEvents([
        {
          since: 2000,
          until: 4000,
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event3', 'event4']);
    });

    it('should handle complex tag combinations', async () => {
      // 特定のpタグとeタグの組み合わせを持つイベントを検索
      const result = await storage.getEvents([
        {
          '#p': ['user1'],
          '#e': ['event1'],
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3', 'event5']);
    });

    it('should handle multiple tag filters with time range', async () => {
      const result = await storage.getEvents([
        {
          '#p': ['user2'],
          '#e': ['event2'],
          since: 3000,
          until: 5000,
        },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('event4');
    });

    it('should handle multiple filters with different tag combinations', async () => {
      const result = await storage.getEvents([
        {
          '#p': ['user1'],
          since: 1000,
          until: 2000,
        },
        {
          '#e': ['event2'],
          since: 3000,
          until: 5000,
        },
      ]);
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event4']);
    });
  });

  describe('Tag Indexing', () => {
    it('should limit indexed tags to MAX_INDEXED_TAGS', async () => {
      // 150個のタグを持つイベントを作成（MAX_INDEXED_TAGS = 100を超える）
      const manyTags = Array.from({ length: 150 }, (_, i) => ['p', `pubkey${i}`]);
      const event = { ...mockEvent, id: 'many-tags-event', tags: manyTags };
      await storage.saveEvent(event);

      // 保存されたイベントを取得して検証
      const result = await storage.getEvents([{ ids: ['many-tags-event'] }]);
      // 元のタグは全て保持されているべき
      expect(result[0].tags.length).toBe(150);

      // indexed_tagsは100に制限されているべき
      // 100番目のタグは検索可能
      const tagSearchResult1 = await storage.getEvents([{ '#p': ['pubkey99'] }]);
      expect(tagSearchResult1).toHaveLength(1);

      // 101番目以降のタグは検索できないはず
      const tagSearchResult2 = await storage.getEvents([{ '#p': ['pubkey120'] }]);
      expect(tagSearchResult2).toHaveLength(0);
    });

    it('should prioritize specific tag types', async () => {
      const mixedTags = [
        ['x', 'value1'], // 非優先タグ
        ['e', 'event1'], // 優先タグ
        ['y', 'value2'], // 非優先タグ
        ['p', 'pubkey1'], // 優先タグ
        ['z', 'value3'], // 非優先タグ
        ['a', 'value4'], // 優先タグ
      ];
      const event = { ...mockEvent, id: 'mixed-tags-event', tags: mixedTags };
      await storage.saveEvent(event);

      // 優先タグによる検索が機能することを確認
      const priorityTagResults = await Promise.all([
        storage.getEvents([{ '#e': ['event1'] }]),
        storage.getEvents([{ '#p': ['pubkey1'] }]),
        storage.getEvents([{ '#a': ['value4'] }]),
      ]);

      for (const result of priorityTagResults) {
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('mixed-tags-event');
      }

      // 非優先タグでも検索可能なことを確認
      const nonPriorityResults = await Promise.all([
        storage.getEvents([{ '#x': ['value1'] }]),
        storage.getEvents([{ '#y': ['value2'] }]),
        storage.getEvents([{ '#z': ['value3'] }]),
      ]);

      for (const result of nonPriorityResults) {
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('mixed-tags-event');
      }
    });

    it('should handle invalid tag formats', async () => {
      const invalidTags = [
        [], // 空配列
        [''], // 空文字列
        ['abc', 'value'], // 2文字以上のキー
        ['1', 'value'], // 数字のキー
        ['@', 'value'], // 特殊文字のキー
        ['p'], // 値なし
      ];
      const event = { ...mockEvent, id: 'invalid-tags-event', tags: invalidTags };
      await storage.saveEvent(event);

      // イベントは保存されるべき
      const result = await storage.getEvents([{ ids: ['invalid-tags-event'] }]);
      expect(result).toHaveLength(1);
      expect(result[0].tags).toEqual(invalidTags);

      // 無効なタグで検索しても結果が返ってこないことを確認
      const invalidTagSearches = await Promise.all([
        storage.getEvents([{ '#': [''] }]),
        storage.getEvents([{ '#abc': ['value'] }]),
        storage.getEvents([{ '#1': ['value'] }]),
        storage.getEvents([{ '#@': ['value'] }]),
        storage.getEvents([{ '#p': [''] }]),
      ]);

      for (const result of invalidTagSearches) {
        expect(result).toHaveLength(0);
      }
    });
  });
});
