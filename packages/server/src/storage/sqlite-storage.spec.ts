/**
 * SqliteStorage unit tests.
 *
 * cache-relay の `dexie-storage.spec.ts` を describe 単位でミラーし、
 * SQLite アダプタが DexieStorage と同一のセマンティクスを持つことを検証する。
 * 加えて SQLite 固有の観点（ファイル永続化・close 後の安全なフォールバック）を
 * 検証する。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as nodeSqlite from 'node:sqlite';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStorage } from './sqlite-storage.js';

// テストからブックキーピング列を検証するための private client（生の DatabaseSync）
// アクセス（dexie spec が storage.table('events') を読むのに相当）
type WithClient = { client: nodeSqlite.DatabaseSync };

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    // Reset storage for each test
    storage = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    storage.close();
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

  describe('validation status', () => {
    const eventWithId = (id: string): NostrEvent => ({ ...mockEvent, id });

    it('should save events as pending by default', async () => {
      await storage.saveEvent(mockEvent);

      const statuses = await storage.getValidationStatus([mockEvent.id]);
      expect(statuses.get(mockEvent.id)).toBe('pending');
    });

    it('should save events as validated when the option is set', async () => {
      await storage.saveEvent(mockEvent, { validated: true });

      const statuses = await storage.getValidationStatus([mockEvent.id]);
      expect(statuses.get(mockEvent.id)).toBe('validated');
    });

    it('should not downgrade a validated event on re-save', async () => {
      await storage.saveEvent(mockEvent, { validated: true });
      // Same id re-ingested without the flag (e.g. upstream echo)
      await storage.saveEvent(mockEvent);

      const statuses = await storage.getValidationStatus([mockEvent.id]);
      expect(statuses.get(mockEvent.id)).toBe('validated');
    });

    it('should report unknown for ids that are not stored', async () => {
      await storage.saveEvent(mockEvent, { validated: true });

      const statuses = await storage.getValidationStatus([mockEvent.id, 'missing-id']);
      expect(statuses.get(mockEvent.id)).toBe('validated');
      expect(statuses.get('missing-id')).toBe('unknown');
      expect(statuses.size).toBe(2);
    });

    it('should mark events as validated in bulk, ignoring missing ids', async () => {
      await storage.saveEvent(eventWithId('a'));
      await storage.saveEvent(eventWithId('b'));

      await storage.markValidated(['a', 'b', 'missing-id']);

      const statuses = await storage.getValidationStatus(['a', 'b', 'missing-id']);
      expect(statuses.get('a')).toBe('validated');
      expect(statuses.get('b')).toBe('validated');
      expect(statuses.get('missing-id')).toBe('unknown');
    });

    it('should return unvalidated events oldest-first and respect the limit', async () => {
      // Control cached_at ordering via a mocked clock
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1000);
      await storage.saveEvent(eventWithId('oldest'));
      nowSpy.mockReturnValue(2000);
      await storage.saveEvent(eventWithId('middle'));
      nowSpy.mockReturnValue(3000);
      await storage.saveEvent(eventWithId('newest'));
      nowSpy.mockRestore();

      const firstTwo = await storage.getUnvalidatedEvents(2);
      expect(firstTwo.map((event) => event.id)).toEqual(['oldest', 'middle']);

      const all = await storage.getUnvalidatedEvents(10);
      expect(all.map((event) => event.id)).toEqual(['oldest', 'middle', 'newest']);
    });

    it('should exclude validated events from the unvalidated scan', async () => {
      await storage.saveEvent(eventWithId('pending-one'));
      await storage.saveEvent(eventWithId('done'), { validated: true });

      const unvalidated = await storage.getUnvalidatedEvents(10);
      expect(unvalidated.map((event) => event.id)).toEqual(['pending-one']);
    });

    it('should return full events from the unvalidated scan', async () => {
      await storage.saveEvent(mockEvent);

      const [event] = await storage.getUnvalidatedEvents(1);
      expect(event).toEqual(mockEvent);
    });

    it('should not track access on status reads or unvalidated scans', async () => {
      await storage.saveEvent(mockEvent);
      await storage.getValidationStatus([mockEvent.id]);
      await storage.getUnvalidatedEvents(10);

      const row = (storage as unknown as WithClient).client
        .prepare('SELECT access_count FROM events WHERE id = ?')
        .get(mockEvent.id) as { access_count: number };
      // Insertion counts as the single access; reads above must not add more
      expect(row.access_count).toBe(1);
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

    // 注: 以下 3 ケースは dexie spec と期待値が異なる（意図的な差分）。
    // NIP-01 の since / until は両端とも包含であり、共通の最終判定
    // （filterUtils.eventMatchesFilter）も包含で扱う。DexieStorage は
    // authors / kinds と時間範囲を組み合わせた分岐でのみ Dexie の between()
    // （上限排他）でインデックスを絞るため until 境界のイベントが落ちるが
    // （時間範囲のみの分岐では +1 補正で包含）、SQLite 実装は全分岐で包含に統一する

    it('should handle multiple authors with time range (until inclusive)', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1', 'author2'],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
    });

    it('should handle multiple kinds with time range (until inclusive)', async () => {
      const result = await storage.getEvents([
        {
          kinds: [1, 2],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
    });

    it('should handle multiple authors and kinds with time range (until inclusive)', async () => {
      const result = await storage.getEvents([
        {
          authors: ['author1', 'author2'],
          kinds: [1, 2],
          since: 1000,
          until: 2000,
        },
      ]);
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
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
      // close 済みの DB への操作はエラーになるが、false で応答すること
      storage.close();

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
      // close 済みの DB への操作はエラーになるが、false で応答すること
      storage.close();

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

    it('should return the newest events when the limit truncates', async () => {
      const result = await storage.getEvents([{ kinds: [1, 2, 3, 4, 5], limit: 2 }]);
      expect(result.map((e) => e.id).sort()).toEqual(['event4', 'event5']);
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

  describe('count', () => {
    it('should return 0 for empty storage', async () => {
      expect(await storage.count()).toBe(0);
    });

    it('should reflect the number of stored events', async () => {
      await storage.saveEvent(mockEvent);
      await storage.saveEvent({ ...mockEvent, id: 'test-id-2' });

      expect(await storage.count()).toBe(2);
    });

    it('should not double-count an event saved twice with the same id', async () => {
      await storage.saveEvent(mockEvent);
      await storage.saveEvent(mockEvent);

      expect(await storage.count()).toBe(1);
    });
  });

  const eventAt = (id: string, created_at: number): NostrEvent => ({
    ...mockEvent,
    id,
    created_at,
  });

  describe('enforceLimit (storageMaxSize / cacheStrategy)', () => {
    it('should not evict while at or under maxSize', async () => {
      await storage.saveEvent(eventAt('a', 1));
      await storage.saveEvent(eventAt('b', 2));
      await storage.saveEvent(eventAt('c', 3));

      const removed = await storage.enforceLimit(3);

      expect(removed).toBe(0);
      expect(await storage.count()).toBe(3);
    });

    it('should evict the oldest events (FIFO) when exceeding maxSize', async () => {
      await storage.saveEvent(eventAt('oldest', 100));
      await storage.saveEvent(eventAt('middle', 200));
      await storage.saveEvent(eventAt('newest', 300));

      const removed = await storage.enforceLimit(2);

      expect(removed).toBe(1);
      expect(await storage.count()).toBe(2);
      const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
      expect(remaining).toEqual(['middle', 'newest']);
    });

    it('should be a no-op for non-positive maxSize', async () => {
      await storage.saveEvent(eventAt('a', 1));
      await storage.saveEvent(eventAt('b', 2));

      expect(await storage.enforceLimit(0)).toBe(0);
      expect(await storage.enforceLimit(-5)).toBe(0);
      expect(await storage.count()).toBe(2);
    });

    it('should evict the least recently read events (LRU)', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await storage.saveEvent(eventAt('a', 100));
      await storage.saveEvent(eventAt('b', 200));
      await storage.saveEvent(eventAt('c', 300));

      // Read 'a' then 'c', leaving 'b' the least recently accessed.
      // (FIFO would have evicted 'a', the oldest by created_at.)
      nowSpy.mockReturnValue(2_000_000);
      await storage.getEvents([{ ids: ['a'] }]);
      nowSpy.mockReturnValue(3_000_000);
      await storage.getEvents([{ ids: ['c'] }]);

      const removed = await storage.enforceLimit(2, 'LRU');

      expect(removed).toBe(1);
      const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
      expect(remaining).toEqual(['a', 'c']);
      nowSpy.mockRestore();
    });

    it('should evict the least frequently read events (LFU)', async () => {
      await storage.saveEvent(eventAt('a', 100));
      await storage.saveEvent(eventAt('b', 200));
      await storage.saveEvent(eventAt('c', 300));

      // 'a' read twice, 'c' once, 'b' never.
      // (FIFO would have evicted 'a', the oldest by created_at.)
      await storage.getEvents([{ ids: ['a'] }]);
      await storage.getEvents([{ ids: ['a'] }]);
      await storage.getEvents([{ ids: ['c'] }]);

      const removed = await storage.enforceLimit(2, 'LFU');

      expect(removed).toBe(1);
      const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
      expect(remaining).toEqual(['a', 'c']);
    });

    it('should not evict a fresh insert (LFU) in favour of never-read events', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await storage.saveEvent(eventAt('stale', 100));

      // Insertion counts as one access, so the fresh insert ties with the
      // never-read event and recency keeps it; the older insert is evicted
      nowSpy.mockReturnValue(2_000_000);
      await storage.saveEvent(eventAt('fresh', 50));

      const removed = await storage.enforceLimit(1, 'LFU');

      expect(removed).toBe(1);
      const remaining = await storage.getEvents([{ kinds: [1] }]);
      expect(remaining.map((e) => e.id)).toEqual(['fresh']);
      nowSpy.mockRestore();
    });

    it('should evict a fresh insert (LFU) before events that have been read', async () => {
      await storage.saveEvent(eventAt('hot', 100));
      // 'hot' reaches access_count 2 (insert + read)
      await storage.getEvents([{ ids: ['hot'] }]);

      // Standard LFU: a fresh insert (access_count 1) loses against read
      // events, even though it is the most recently touched
      await storage.saveEvent(eventAt('cold-newcomer', 200));

      const removed = await storage.enforceLimit(1, 'LFU');

      expect(removed).toBe(1);
      const remaining = await storage.getEvents([{ kinds: [1] }]);
      expect(remaining.map((e) => e.id)).toEqual(['hot']);
    });

    it('should break LFU ties by least recently read', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await storage.saveEvent(eventAt('x', 100));
      await storage.saveEvent(eventAt('y', 200));

      // Both read once, but 'y' longer ago than 'x'
      nowSpy.mockReturnValue(2_000_000);
      await storage.getEvents([{ ids: ['y'] }]);
      nowSpy.mockReturnValue(3_000_000);
      await storage.getEvents([{ ids: ['x'] }]);

      const removed = await storage.enforceLimit(1, 'LFU');

      expect(removed).toBe(1);
      const remaining = await storage.getEvents([{ kinds: [1] }]);
      expect(remaining[0].id).toBe('x');
      nowSpy.mockRestore();
    });
  });

  describe('deleteExpired', () => {
    it('should delete only events cached strictly before the threshold', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      // cached_at はミリ秒、deleteExpired の閾値は秒
      nowSpy.mockReturnValue(100_000);
      await storage.saveEvent(eventAt('old', 1));
      nowSpy.mockReturnValue(200_000);
      await storage.saveEvent(eventAt('boundary', 2));
      nowSpy.mockReturnValue(300_000);
      await storage.saveEvent(eventAt('fresh', 3));
      nowSpy.mockRestore();

      const removed = await storage.deleteExpired(200);

      // 'old' (cached before 200s) deleted; 'boundary' (==200s) and 'fresh' kept
      expect(removed).toBe(1);
      const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
      expect(remaining).toEqual(['boundary', 'fresh']);
    });

    it('should expire by cache insertion time, not created_at', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      // created_at はとうに古いが、たった今キャッシュに入ったイベント
      nowSpy.mockReturnValue(500_000);
      await storage.saveEvent(eventAt('old-event-fresh-cache', 1));
      // created_at は新しいが、キャッシュ投入がずっと前のイベント
      nowSpy.mockReturnValue(100_000);
      await storage.saveEvent(eventAt('new-event-stale-cache', 400));
      nowSpy.mockRestore();

      const removed = await storage.deleteExpired(300);

      expect(removed).toBe(1);
      const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id);
      expect(remaining).toEqual(['old-event-fresh-cache']);
    });

    it('should refresh the TTL when an event is saved again', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(100_000);
      await storage.saveEvent(eventAt('re-put', 1));
      // 再 put で cached_at が更新され、期限が数え直しになる
      nowSpy.mockReturnValue(400_000);
      await storage.saveEvent(eventAt('re-put', 1));
      nowSpy.mockRestore();

      expect(await storage.deleteExpired(300)).toBe(0);
      expect(await storage.count()).toBe(1);
    });

    it('should return 0 when nothing is expired', async () => {
      await storage.saveEvent(eventAt('a', 500));

      expect(await storage.deleteExpired(100)).toBe(0);
      expect(await storage.count()).toBe(1);
    });
  });

  describe('file persistence (SQLite-specific)', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'nostr-sqlite-'));
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('should keep events and validation status across close/reopen', async () => {
      const dbPath = join(dataDir, 'relay.db');
      const persistent = new SqliteStorage(dbPath);
      await persistent.saveEvent({ ...mockEvent, id: 'validated-one' }, { validated: true });
      await persistent.saveEvent({ ...mockEvent, id: 'pending-one' });
      persistent.close();

      const reopened = new SqliteStorage(dbPath);
      try {
        expect(await reopened.count()).toBe(2);

        const events = await reopened.getEvents([{ authors: [mockEvent.pubkey] }]);
        expect(events.map((e) => e.id).sort()).toEqual(['pending-one', 'validated-one']);
        // タグ配列も完全にラウンドトリップすること
        expect(events[0].tags).toEqual(mockEvent.tags);

        const statuses = await reopened.getValidationStatus(['validated-one', 'pending-one']);
        expect(statuses.get('validated-one')).toBe('validated');
        expect(statuses.get('pending-one')).toBe('pending');
      } finally {
        reopened.close();
      }
    });

    it('should create parent directories for the database file', async () => {
      const dbPath = join(dataDir, 'nested', 'dirs', 'relay.db');
      const persistent = new SqliteStorage(dbPath);
      expect(await persistent.saveEvent(mockEvent)).toBe(true);
      persistent.close();
    });

    it('should reopen the same instance after close via open()', async () => {
      const dbPath = join(dataDir, 'relay.db');
      const persistent = new SqliteStorage(dbPath);
      await persistent.saveEvent(mockEvent);
      persistent.close();

      // close 後は操作がフォールバック値になるが、open() で同一インスタンスを再利用できる
      expect(await persistent.count()).toBe(0);
      persistent.open();
      try {
        expect(await persistent.count()).toBe(1);
        expect(await persistent.saveEvent({ ...mockEvent, id: 'after-reopen' })).toBe(true);
      } finally {
        persistent.close();
      }
    });
  });

  describe('error fallbacks after close (SQLite-specific)', () => {
    it('should return safe fallback values instead of throwing', async () => {
      await storage.saveEvent(mockEvent);
      storage.close();

      expect(await storage.saveEvent({ ...mockEvent, id: 'other' })).toBe(false);
      expect(await storage.getEvents([{ ids: [mockEvent.id] }])).toEqual([]);
      expect(await storage.getUnvalidatedEvents(10)).toEqual([]);
      expect((await storage.getValidationStatus([mockEvent.id])).get(mockEvent.id)).toBe('unknown');
      expect(await storage.deleteEvent(mockEvent.id)).toBe(false);
      expect(await storage.count()).toBe(0);
      expect(await storage.deleteExpired(999_999_999)).toBe(0);
      expect(await storage.enforceLimit(1)).toBe(0);
      // markValidated / clear は例外を投げないこと
      await expect(storage.markValidated([mockEvent.id])).resolves.toBeUndefined();
      await expect(storage.clear()).resolves.toBeUndefined();
    });
  });
});
