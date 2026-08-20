/**
 * `StorageAdapter` の共通適合性テスト（conformance suite）。
 *
 * doc/api.md は「どのストレージ実装も同一のセマンティクスを持つ」と宣言している
 * ため、その契約を実装ごとに書き写すのではなく、この 1 か所で定義して各実装から
 * 呼び出す。バックエンド固有の観点（Dexie のトランザクション例外・SQLite の
 * ファイル永続化など）は、各実装の spec 側に残す。
 *
 * 使い方:
 *
 * ```ts
 * describeStorageAdapterConformance('DexieStorage', {
 *   create: () => new DexieStorage('TestNostrCacheRelay'),
 *   dispose: async (storage) => { ... },
 *   readBookkeeping: async (storage, id) => ({ ... }),
 * });
 * ```
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../storage/storage-adapter.js';

/**
 * 適合性テストが対象とするストレージ。オプション扱いのケイパビリティも
 * すべて実装していることを要求する。
 */
export type ConformantStorage = StorageAdapter &
  Required<
    Pick<StorageAdapter, 'getCachedAt' | 'touchCachedAt' | 'deleteExpired' | 'enforceLimit'>
  >;

/**
 * 公開 API では観測できないブックキーピング列。バックエンドごとに保持形式が
 * 違うため、ハーネス経由で読み出す。
 */
export interface StorageBookkeeping {
  /** 署名検証済みか（バックエンドが 0/1 で持つ場合はハーネス側で正規化する） */
  validated: boolean;
  /** 挿入 1 回を含む累積アクセス回数 */
  accessCount: number;
}

export interface StorageConformanceHarness<T extends ConformantStorage = ConformantStorage> {
  /**
   * テスト 1 件ごとに**空の**ストレージを作る。テスト間で状態を持ち越さないのは
   * ハーネスの責務で、`beforeEach` が実際に空であることを検証する。
   */
  create(): T | Promise<T>;
  /** {@link create} で作ったストレージを破棄する */
  dispose(storage: T): void | Promise<void>;
  /**
   * 1 イベント分のブックキーピング列を読む。id が存在しない場合は `undefined` を
   * 返す（アサーションが低レベルな例外ではなく差分として出るようにするため）。
   */
  readBookkeeping(
    storage: T,
    id: string
  ): StorageBookkeeping | undefined | Promise<StorageBookkeeping | undefined>;
}

/** 適合性テストが共有する基準イベント */
export const CONFORMANCE_MOCK_EVENT: NostrEvent = {
  id: 'test-id',
  pubkey: 'test-pubkey',
  created_at: 1234567890,
  kind: 1,
  tags: [['p', 'test-pubkey']],
  content: 'test content',
  sig: 'test-sig',
};

export function describeStorageAdapterConformance<T extends ConformantStorage>(
  name: string,
  harness: StorageConformanceHarness<T>
): void {
  describe(`${name} (StorageAdapter conformance)`, () => {
    let storage: T;

    beforeEach(async () => {
      storage = await harness.create();
      // ハーネスの隔離契約を機械的に強制する。ここが落ちるなら dispose() が
      // 前のテストの状態を残しており、以降の期待値はすべて信用できない
      expect(await storage.count()).toBe(0);
    });

    afterEach(async () => {
      // Date.now のスパイを張るテストがあるため、dispose より先に必ず戻す。
      // 残したままだと以降のテスト全体へ固定時刻が漏れる
      vi.restoreAllMocks();
      await harness.dispose(storage);
    });

    const mockEvent = CONFORMANCE_MOCK_EVENT;
    const eventWithId = (id: string): NostrEvent => ({ ...mockEvent, id });
    const eventAt = (id: string, created_at: number): NostrEvent => ({
      ...mockEvent,
      id,
      created_at,
    });
    const eventBy = (id: string, created_at: number, pubkey: string, kind = 1): NostrEvent => ({
      ...mockEvent,
      id,
      created_at,
      pubkey,
      kind,
    });
    const eventOfKind = (id: string, kind: number, created_at: number): NostrEvent => ({
      id,
      pubkey: 'author',
      created_at,
      kind,
      tags: [],
      content: 'content',
      sig: 'sig',
    });
    const bookkeeping = async (id: string): Promise<StorageBookkeeping> => {
      const row = await harness.readBookkeeping(storage, id);
      // 存在しない id をブックキーピングの期待値と比べようとしている＝テスト側の
      // 前提が崩れている。`undefined.accessCount` の TypeError より読みやすく落とす
      expect(row, `no stored row for id "${id}"`).toBeDefined();
      return row as StorageBookkeeping;
    };

    describe('saveEvent', () => {
      it('should save event successfully', async () => {
        expect(await storage.saveEvent(mockEvent)).toBe(true);
      });

      it('should return false on error', async () => {
        // Force an error by trying to save an invalid event
        expect(await storage.saveEvent({} as NostrEvent)).toBe(false);
      });
    });

    describe('validation status', () => {
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

        // Insertion counts as the single access; reads above must not add more
        expect((await bookkeeping(mockEvent.id)).accessCount).toBe(1);
      });
    });

    describe('getCachedAt (freshness window)', () => {
      it('should return the cache insertion time in milliseconds', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        await storage.saveEvent(mockEvent);
        nowSpy.mockRestore();

        const cachedAt = await storage.getCachedAt([mockEvent.id]);
        expect(cachedAt.get(mockEvent.id)).toBe(1_700_000_000_000);
      });

      it('should reflect the re-save time (TTL and freshness restart together)', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
        await storage.saveEvent(mockEvent);
        nowSpy.mockReturnValue(5000);
        await storage.saveEvent(mockEvent);
        nowSpy.mockRestore();

        const cachedAt = await storage.getCachedAt([mockEvent.id]);
        expect(cachedAt.get(mockEvent.id)).toBe(5000);
      });

      it('should omit ids that are not stored', async () => {
        await storage.saveEvent(mockEvent);

        const cachedAt = await storage.getCachedAt([mockEvent.id, 'missing-id']);
        expect(cachedAt.has('missing-id')).toBe(false);
        expect(cachedAt.size).toBe(1);
      });

      it('should return an empty map for no ids', async () => {
        expect((await storage.getCachedAt([])).size).toBe(0);
      });

      it('should look up several ids at once', async () => {
        await storage.saveEvent(eventWithId('a'));
        await storage.saveEvent(eventWithId('b'));

        const cachedAt = await storage.getCachedAt(['a', 'b']);
        expect([...cachedAt.keys()].sort()).toEqual(['a', 'b']);
      });

      it('should not track access (a freshness check must not disturb LRU/LFU)', async () => {
        await storage.saveEvent(mockEvent);
        await storage.getCachedAt([mockEvent.id]);

        expect((await bookkeeping(mockEvent.id)).accessCount).toBe(1);
      });
    });

    describe('touchCachedAt (re-arming the freshness window)', () => {
      it('should re-stamp cached_at to now and report the count', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
        await storage.saveEvent(mockEvent);
        nowSpy.mockReturnValue(9000);
        const updated = await storage.touchCachedAt([mockEvent.id]);
        nowSpy.mockRestore();

        expect(updated).toBe(1);
        expect((await storage.getCachedAt([mockEvent.id])).get(mockEvent.id)).toBe(9000);
      });

      it('should skip ids that are not stored', async () => {
        await storage.saveEvent(mockEvent);

        expect(await storage.touchCachedAt(['missing-id'])).toBe(0);
        expect(await storage.touchCachedAt([mockEvent.id, 'missing-id'])).toBe(1);
      });

      it('should be a no-op for an empty id list', async () => {
        expect(await storage.touchCachedAt([])).toBe(0);
      });

      it('should re-stamp several ids at once', async () => {
        await storage.saveEvent(eventWithId('a'));
        await storage.saveEvent(eventWithId('b'));

        expect(await storage.touchCachedAt(['a', 'b'])).toBe(2);
      });

      it('should not change validation state or access metadata', async () => {
        await storage.saveEvent(mockEvent, { validated: true });
        await storage.touchCachedAt([mockEvent.id]);

        expect(await bookkeeping(mockEvent.id)).toEqual({ validated: true, accessCount: 1 });
        expect((await storage.getValidationStatus([mockEvent.id])).get(mockEvent.id)).toBe(
          'validated'
        );
      });

      it('should keep a pending event pending', async () => {
        await storage.saveEvent(mockEvent);
        await storage.touchCachedAt([mockEvent.id]);

        expect((await storage.getValidationStatus([mockEvent.id])).get(mockEvent.id)).toBe(
          'pending'
        );
      });

      it('should leave the event body untouched', async () => {
        await storage.saveEvent(mockEvent);
        await storage.touchCachedAt([mockEvent.id]);

        const [stored] = await storage.getEvents([{ ids: [mockEvent.id] }]);
        expect(stored).toEqual(mockEvent);
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
        expect(await storage.getEvents([{ ids: ['non-existent'] }])).toHaveLength(0);
      });

      it('should handle multiple filters', async () => {
        const events = await storage.getEvents([
          { ids: ['test-id'] },
          { authors: ['test-pubkey'] },
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(mockEvent);
      });

      it('should get events by tags', async () => {
        const events = await storage.getEvents([{ '#p': ['test-pubkey'] }]);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(mockEvent);
      });

      it('should return empty array when tag value does not match', async () => {
        expect(await storage.getEvents([{ '#p': ['non-existent'] }])).toHaveLength(0);
      });
    });

    describe('getEvents with multiple conditions', () => {
      const events: NostrEvent[] = [
        { ...eventBy('event1', 1000, 'author1', 1), tags: [] },
        { ...eventBy('event2', 2000, 'author1', 1), tags: [] },
        { ...eventBy('event3', 1500, 'author2', 2), tags: [] },
      ];

      beforeEach(async () => {
        for (const event of events) {
          await storage.saveEvent(event);
        }
      });

      it('should filter by authors and time range', async () => {
        const result = await storage.getEvents([
          { authors: ['author1'], since: 1500, until: 2500 },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('event2');
      });

      it('should filter by authors, kinds and time range', async () => {
        const result = await storage.getEvents([
          { authors: ['author1'], kinds: [1], since: 500, until: 1500 },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('event1');
      });

      // since / until はいずれも境界を含む（NIP-01）。event2 は until と同時刻なので
      // 結果に含まれる
      it('should handle multiple authors with time range (until inclusive)', async () => {
        const result = await storage.getEvents([
          { authors: ['author1', 'author2'], since: 1000, until: 2000 },
        ]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
      });

      it('should handle multiple kinds with time range (until inclusive)', async () => {
        const result = await storage.getEvents([{ kinds: [1, 2], since: 1000, until: 2000 }]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
      });

      it('should handle multiple authors and kinds with time range (until inclusive)', async () => {
        const result = await storage.getEvents([
          { authors: ['author1', 'author2'], kinds: [1, 2], since: 1000, until: 2000 },
        ]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
      });
    });

    describe('deleteEvent', () => {
      beforeEach(async () => {
        await storage.saveEvent(mockEvent);
      });

      it('should delete event successfully', async () => {
        expect(await storage.deleteEvent('test-id')).toBe(true);
        expect(await storage.getEvents([{ ids: ['test-id'] }])).toHaveLength(0);
      });

      it('should return false when event not found', async () => {
        expect(await storage.deleteEvent('non-existent')).toBe(false);
      });
    });

    describe('clear', () => {
      it('should clear all events', async () => {
        await storage.saveEvent(mockEvent);

        await storage.clear();

        expect(await storage.getEvents([{}])).toHaveLength(0);
      });
    });

    describe('deleteEventsByPubkeyAndKind', () => {
      beforeEach(async () => {
        // 同一 author/kind の 2 件 + 別 author + 別 kind
        await storage.saveEvent(eventBy('event1', 1000, 'author1', 0));
        await storage.saveEvent(eventBy('event2', 2000, 'author1', 0));
        await storage.saveEvent(eventBy('event3', 1500, 'author2', 0));
        await storage.saveEvent(eventBy('event4', 3000, 'author1', 1));
      });

      it('should delete events with matching pubkey and kind', async () => {
        expect(await storage.deleteEventsByPubkeyAndKind('author1', 0)).toBe(true);

        expect(await storage.getEvents([{ authors: ['author1'], kinds: [0] }])).toHaveLength(0);
        const remaining = (await storage.getEvents([{}])).map((e) => e.id).sort();
        expect(remaining).toEqual(['event3', 'event4']);
      });

      it('should return false when no events match', async () => {
        expect(await storage.deleteEventsByPubkeyAndKind('non-existent', 999)).toBe(false);
        expect(await storage.getEvents([{}])).toHaveLength(4);
      });
    });

    describe('deleteEventsByPubkeyKindAndDTag', () => {
      const addressable = (
        id: string,
        created_at: number,
        pubkey: string,
        kind: number,
        tags: string[][]
      ): NostrEvent => ({ ...eventBy(id, created_at, pubkey, kind), tags });

      beforeEach(async () => {
        const events = [
          addressable('addr1', 1000, 'author1', 30001, [['d', 'test1']]),
          addressable('addr2', 2000, 'author1', 30001, [['d', 'test1']]),
          // 別 d タグ / 別 author / 別 kind
          addressable('addr3', 3000, 'author1', 30001, [['d', 'test2']]),
          addressable('addr4', 4000, 'author2', 30001, [['d', 'test1']]),
          addressable('addr5', 5000, 'author1', 30002, [['d', 'test1']]),
          // d タグの位置が先頭ではないケース
          addressable('addr6', 6000, 'author1', 30001, [
            ['d', 'test1'],
            ['e', 'event1'],
          ]),
          addressable('addr7', 7000, 'author1', 30001, [
            ['e', 'event1'],
            ['d', 'test1'],
          ]),
        ];
        for (const event of events) {
          await storage.saveEvent(event);
        }
      });

      it('should delete events with matching pubkey, kind and d tag', async () => {
        expect(await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1')).toBe(true);

        const remaining = (await storage.getEvents([{}])).map((e) => e.id).sort();
        expect(remaining).toEqual(['addr3', 'addr4', 'addr5']);
      });

      it('should delete events regardless of tag position', async () => {
        // addr7 は d タグの位置が異なるが、削除されるべき
        await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');

        expect(await storage.getEvents([{ ids: ['addr7'] }])).toHaveLength(0);
      });

      it('should not delete events with different d tag values', async () => {
        await storage.deleteEventsByPubkeyKindAndDTag('author1', 30001, 'test1');

        const events = await storage.getEvents([{ kinds: [30001], '#d': ['test2'] }]);
        expect(events.map((e) => e.id)).toEqual(['addr3']);
      });

      it('should return false when no events match', async () => {
        expect(
          await storage.deleteEventsByPubkeyKindAndDTag('non-existent', 999, 'non-existent')
        ).toBe(false);
        expect(await storage.getEvents([{}])).toHaveLength(7);
      });
    });

    describe('getCurrentVersion (NIP-01 replaceable / addressable)', () => {
      const withTags = (event: NostrEvent, tags: string[][]): NostrEvent => ({ ...event, tags });

      it('should return undefined when the coordinate holds no event', async () => {
        expect(
          await storage.getCurrentVersion({ kind: 0, pubkey: 'author1', identifier: '' })
        ).toBeUndefined();
      });

      it('should return the stored version of a replaceable coordinate', async () => {
        await storage.saveEvent(eventBy('profile1', 1000, 'author1', 0));
        // 別 author / 別 kind は同じ座標ではない
        await storage.saveEvent(eventBy('profile2', 2000, 'author2', 0));
        await storage.saveEvent(eventBy('follows', 3000, 'author1', 3));

        const current = await storage.getCurrentVersion({
          kind: 0,
          pubkey: 'author1',
          identifier: '',
        });
        expect(current?.id).toBe('profile1');
      });

      it('should ignore the identifier for replaceable kinds', async () => {
        // 置換可能 kind は d タグを持たない（あっても座標には含まれない）
        await storage.saveEvent(withTags(eventBy('profile1', 1000, 'author1', 0), [['d', 'x']]));

        const current = await storage.getCurrentVersion({
          kind: 0,
          pubkey: 'author1',
          identifier: 'ignored',
        });
        expect(current?.id).toBe('profile1');
      });

      it('should pick the newest version when several are stored', async () => {
        // 版比較が入る前に書かれた行・他の書き手が入れた行を想定
        await storage.saveEvent(eventBy('old', 1000, 'author1', 0));
        await storage.saveEvent(eventBy('new', 3000, 'author1', 0));
        await storage.saveEvent(eventBy('mid', 2000, 'author1', 0));

        const current = await storage.getCurrentVersion({
          kind: 0,
          pubkey: 'author1',
          identifier: '',
        });
        expect(current?.id).toBe('new');
      });

      it('should break created_at ties by the lowest id', async () => {
        await storage.saveEvent(eventBy('bbbb', 1000, 'author1', 0));
        await storage.saveEvent(eventBy('aaaa', 1000, 'author1', 0));
        await storage.saveEvent(eventBy('cccc', 1000, 'author1', 0));

        const current = await storage.getCurrentVersion({
          kind: 0,
          pubkey: 'author1',
          identifier: '',
        });
        expect(current?.id).toBe('aaaa');
      });

      it('should match the d identifier for addressable kinds', async () => {
        await storage.saveEvent(withTags(eventBy('slug-a', 1000, 'author1', 30023), [['d', 'a']]));
        await storage.saveEvent(
          withTags(eventBy('slug-b', 2000, 'author1', 30023), [
            ['e', 'other'],
            ['d', 'b'],
          ])
        );
        // d タグ無しは空識別子（NIP-01）
        await storage.saveEvent(eventBy('no-d', 3000, 'author1', 30023));

        expect(
          (await storage.getCurrentVersion({ kind: 30023, pubkey: 'author1', identifier: 'a' }))?.id
        ).toBe('slug-a');
        expect(
          (await storage.getCurrentVersion({ kind: 30023, pubkey: 'author1', identifier: 'b' }))?.id
        ).toBe('slug-b');
        expect(
          (await storage.getCurrentVersion({ kind: 30023, pubkey: 'author1', identifier: '' }))?.id
        ).toBe('no-d');
        expect(
          await storage.getCurrentVersion({ kind: 30023, pubkey: 'author1', identifier: 'none' })
        ).toBeUndefined();
      });

      it('should return the event as stored', async () => {
        const event = withTags(eventBy('profile1', 1000, 'author1', 0), [['p', 'someone']]);
        await storage.saveEvent(event);

        expect(
          await storage.getCurrentVersion({ kind: 0, pubkey: 'author1', identifier: '' })
        ).toEqual(event);
      });

      it('should not count as a read access (LRU/LFU)', async () => {
        await storage.saveEvent(eventBy('profile1', 1000, 'author1', 0));

        await storage.getCurrentVersion({ kind: 0, pubkey: 'author1', identifier: '' });

        // 挿入の 1 回のみ。書き込み経路の事前確認は読み出しではない
        expect((await bookkeeping('profile1')).accessCount).toBe(1);
      });
    });

    describe('Additional getEvents Patterns', () => {
      // created_at 1000..5000 / kind 1..5 / author1..author5、#p は user1/user2 交互
      const events: NostrEvent[] = Array.from({ length: 5 }, (_, i) => {
        const n = i + 1;
        const user = n % 2 === 1 ? 'user1' : 'user2';
        const ref = n % 2 === 1 ? 'event1' : 'event2';
        return {
          id: `event${n}`,
          pubkey: `author${n}`,
          created_at: n * 1000,
          kind: n,
          tags: [
            ['p', user],
            ['e', ref],
          ],
          content: `test${n}`,
          sig: `sig${n}`,
        };
      });

      beforeEach(async () => {
        for (const event of events) {
          await storage.saveEvent(event);
        }
      });

      it('should respect limit parameter', async () => {
        expect(await storage.getEvents([{ limit: 3 }])).toHaveLength(3);
      });

      it('should respect limit parameter with other filters', async () => {
        const result = await storage.getEvents([
          { authors: ['author1', 'author2', 'author3', 'author4', 'author5'], limit: 2 },
        ]);
        expect(result).toHaveLength(2);
      });

      it('should filter by time range only', async () => {
        const result = await storage.getEvents([{ since: 2000, until: 4000 }]);
        expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event3', 'event4']);
      });

      it('should handle complex tag combinations', async () => {
        const result = await storage.getEvents([{ '#p': ['user1'], '#e': ['event1'] }]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3', 'event5']);
      });

      // A tag condition beside `kinds` / `authors` is the shape a post detail
      // asks with (`{kinds:[1],'#e':[…]}` for the thread, `{kinds:[7],…}` for
      // the reactions), and an adapter is free to serve it from whichever index
      // it likes — so the results are pinned here rather than in an
      // adapter-specific spec.
      it('should combine a tag filter with kinds', async () => {
        const result = await storage.getEvents([{ kinds: [1, 3], '#e': ['event1'] }]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event3']);
      });

      it('should combine a tag filter with authors and a time range', async () => {
        const result = await storage.getEvents([
          { authors: ['author1', 'author3'], '#p': ['user1'], since: 2000 },
        ]);
        expect(result.map((e) => e.id)).toEqual(['event3']);
      });

      it('should return nothing when the kinds and the tag disagree', async () => {
        expect(await storage.getEvents([{ kinds: [2], '#e': ['event1'] }])).toEqual([]);
      });

      // An event carrying two of the filter's tag values matches once, not
      // twice. A NIP-10 reply names its root and its parent, so a thread level
      // asking about both hits this on every reply it wants — and counting one
      // event twice against `limit` silently halves the answer.
      it('should count an event matching two tag values once against limit', async () => {
        for (const n of [1, 2]) {
          await storage.saveEvent({
            id: `both${n}`,
            pubkey: 'author9',
            created_at: 9000 + n,
            kind: 9,
            tags: [
              ['e', 'root9'],
              ['e', 'parent9'],
            ],
            content: `both${n}`,
            sig: `sig-both${n}`,
          });
        }

        const result = await storage.getEvents([
          { kinds: [9], '#e': ['root9', 'parent9'], limit: 2 },
        ]);

        expect(result.map((e) => e.id).sort()).toEqual(['both1', 'both2']);
      });

      it('should handle multiple tag filters with time range', async () => {
        const result = await storage.getEvents([
          { '#p': ['user2'], '#e': ['event2'], since: 3000, until: 5000 },
        ]);
        expect(result.map((e) => e.id)).toEqual(['event4']);
      });

      it('should handle multiple filters with different tag combinations', async () => {
        const result = await storage.getEvents([
          { '#p': ['user1'], since: 1000, until: 2000 },
          { '#e': ['event2'], since: 3000, until: 5000 },
        ]);
        expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event4']);
      });

      // NIP-01 の limit は「一致するイベントのうち最新 N 件を、新しい順で」。
      // インデックス順の先頭 N 件を返してしまう実装を弾くため、選ばれる集合と
      // 返却順の両方を検証する（順序は sort() せず配列のまま比較すること）
      describe('limit returns the newest events (NIP-01)', () => {
        it('should return the newest N events for a bare limit', async () => {
          const result = await storage.getEvents([{ limit: 3 }]);
          expect(result.map((e) => e.id)).toEqual(['event5', 'event4', 'event3']);
        });

        it('should return the newest N events when narrowed by the kind index', async () => {
          const result = await storage.getEvents([{ kinds: [1, 2, 3, 4, 5], limit: 2 }]);
          expect(result.map((e) => e.id)).toEqual(['event5', 'event4']);
        });

        it('should return the newest N events when narrowed by the pubkey index', async () => {
          const result = await storage.getEvents([
            { authors: ['author1', 'author2', 'author3', 'author4', 'author5'], limit: 2 },
          ]);
          expect(result.map((e) => e.id)).toEqual(['event5', 'event4']);
        });

        it('should return the newest N events when narrowed by the tag index', async () => {
          // event1(1000) / event3(3000) / event5(5000) が #p=user1
          const result = await storage.getEvents([{ '#p': ['user1'], limit: 2 }]);
          expect(result.map((e) => e.id)).toEqual(['event5', 'event3']);
        });

        // 一致件数が limit 以下でも「新しい順」の要件は変わらない。web-client の既定
        // フィルタ（{ kinds: [1], limit: 100 }）はキャッシュが 100 件未満のとき
        // 常にこの経路を通る
        it('should still order newest-first when fewer events match than the limit', async () => {
          const result = await storage.getEvents([{ kinds: [1, 2, 3, 4, 5], limit: 100 }]);
          expect(result.map((e) => e.id)).toEqual([
            'event5',
            'event4',
            'event3',
            'event2',
            'event1',
          ]);
        });

        it('should normalize a fractional limit instead of failing', async () => {
          const result = await storage.getEvents([{ kinds: [1, 2, 3, 4, 5], limit: 2.7 }]);
          expect(result.map((e) => e.id)).toEqual(['event5', 'event4']);
        });

        it('should treat a NaN limit as no client-imposed limit', async () => {
          const result = await storage.getEvents([{ kinds: [1, 2, 3, 4, 5], limit: Number.NaN }]);
          expect(result).toHaveLength(5);
        });

        it('should return no events for a negative limit', async () => {
          expect(await storage.getEvents([{ limit: -1 }])).toEqual([]);
        });

        it('should break ties by id so truncation is deterministic', async () => {
          await storage.saveEvent({
            id: 'aaa-same-time',
            pubkey: 'author9',
            created_at: 5000,
            kind: 9,
            tags: [],
            content: 'same time as event5',
            sig: 'sig9',
          });

          const result = await storage.getEvents([{ limit: 1 }]);
          // created_at が同値なら id の辞書順が小さい方を採用
          expect(result.map((e) => e.id)).toEqual(['aaa-same-time']);
        });

        it('should return no events for limit 0', async () => {
          expect(await storage.getEvents([{ limit: 0 }])).toEqual([]);
        });

        it('should apply limit per filter, not to the merged result', async () => {
          const result = await storage.getEvents([
            { kinds: [1, 2], limit: 1 },
            { kinds: [4, 5], limit: 1 },
          ]);
          expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event5']);
        });

        // フォロータイムライン（`<nostr-follow-timeline>`）が投げる形。一致件数が
        // limit を大きく超えるのが常態で、アダプタが「新しい順に走査して N 件で
        // 打ち切る」実装を採るならその打ち切りが正しいことをここで縛る
        describe('the follow-timeline shape (kinds + many authors + limit)', () => {
          // 20 人。「著者ごとにカーソルを開く」戦略が割に合わなくなる規模
          // （DexieStorage の MAX_ORDERED_AUTHOR_CURSORS = 16）を意図的に超えて
          // いるので、著者ごとの経路と kind 走査の経路が両方この describe で通る
          const authors = Array.from({ length: 20 }, (_, i) => `follow${i}`);

          beforeEach(async () => {
            // 一致 24 件（kind 1）。ほかに limit に混ざってはいけない行も置く
            for (let i = 0; i < 24; i++) {
              await storage.saveEvent({
                id: `follow-note-${String(i).padStart(2, '0')}`,
                pubkey: authors[i % authors.length],
                created_at: 10_000 + i,
                kind: 1,
                tags: [],
                content: `note ${i}`,
                sig: 'sig',
              });
            }
            // フォロー外の著者の、いちばん新しい kind 1
            await storage.saveEvent({
              id: 'stranger-note',
              pubkey: 'stranger',
              created_at: 99_999,
              kind: 1,
              tags: [],
              content: 'not followed',
              sig: 'sig',
            });
            // フォロー中の著者の、いちばん新しい別 kind
            await storage.saveEvent({
              id: 'follow-reaction',
              pubkey: authors[0],
              created_at: 99_999,
              kind: 7,
              tags: [],
              content: '+',
              sig: 'sig',
            });
          });

          it('should return the newest N of the followed authors only', async () => {
            const result = await storage.getEvents([{ kinds: [1], authors, limit: 5 }]);
            expect(result.map((e) => e.id)).toEqual([
              'follow-note-23',
              'follow-note-22',
              'follow-note-21',
              'follow-note-20',
              'follow-note-19',
            ]);
          });

          it('should break a tie at the truncation boundary by the lowest id', async () => {
            // 境界（follow-note-19）と同時刻の 2 件。id 昇順で先に来る方だけが残る
            for (const id of ['aaa-tied', 'zzz-tied']) {
              await storage.saveEvent({
                id,
                pubkey: authors[0],
                created_at: 10_019,
                kind: 1,
                tags: [],
                content: 'tied',
                sig: 'sig',
              });
            }

            const result = await storage.getEvents([{ kinds: [1], authors, limit: 5 }]);
            expect(result.map((e) => e.id)).toEqual([
              'follow-note-23',
              'follow-note-22',
              'follow-note-21',
              'follow-note-20',
              'aaa-tied',
            ]);
          });

          it('should honour a time range alongside the limit, bounds included', async () => {
            const result = await storage.getEvents([
              { kinds: [1], authors, since: 10_005, until: 10_010, limit: 3 },
            ]);
            expect(result.map((e) => e.id)).toEqual([
              'follow-note-10',
              'follow-note-09',
              'follow-note-08',
            ]);
          });

          it('should take the newest N across several kinds, not N per kind', async () => {
            const result = await storage.getEvents([{ kinds: [1, 7], authors, limit: 3 }]);
            expect(result.map((e) => e.id)).toEqual([
              'follow-reaction',
              'follow-note-23',
              'follow-note-22',
            ]);
          });

          it('should return every match when fewer of them than the limit', async () => {
            const result = await storage.getEvents([
              { kinds: [1], authors: [authors[0]], limit: 50 },
            ]);
            expect(result.map((e) => e.id)).toEqual(['follow-note-20', 'follow-note-00']);
          });
        });
      });

      // since / until はどちらも境界を含む（NIP-01）。範囲クエリの上限を排他で
      // 実装すると境界のイベントが落ちるため、時間範囲を使う各分岐を確認する
      describe('since / until bounds are inclusive (NIP-01)', () => {
        it('should include the until boundary on the time-only branch', async () => {
          const result = await storage.getEvents([{ until: 3000 }]);
          expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2', 'event3']);
        });

        it('should include the until boundary on the authors + time branch', async () => {
          const result = await storage.getEvents([
            { authors: ['author2', 'author3'], since: 2000, until: 3000 },
          ]);
          expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event3']);
        });

        it('should include the until boundary on the kinds + time branch', async () => {
          const result = await storage.getEvents([{ kinds: [2, 3], since: 2000, until: 3000 }]);
          expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event3']);
        });

        it('should include the until boundary on the authors + kinds + time branch', async () => {
          const result = await storage.getEvents([
            { authors: ['author2', 'author3'], kinds: [2, 3], since: 2000, until: 3000 },
          ]);
          expect(result.map((e) => e.id).sort()).toEqual(['event2', 'event3']);
        });

        it('should include events sitting exactly on both bounds', async () => {
          const result = await storage.getEvents([
            { authors: ['author3'], kinds: [3], since: 3000, until: 3000 },
          ]);
          expect(result.map((e) => e.id)).toEqual(['event3']);
        });

        // `until: 0` / `since: 0` は「指定なし」ではなく実際の境界として扱う
        // （truthy 判定で無視すると、インデックス絞り込みと最終判定が割れる）
        it('should treat until: 0 as a real bound, not as unset', async () => {
          expect(await storage.getEvents([{ until: 0 }])).toEqual([]);
        });

        it('should treat since: 0 as a real bound, not as unset', async () => {
          const result = await storage.getEvents([{ since: 0, until: 2000 }]);
          expect(result.map((e) => e.id).sort()).toEqual(['event1', 'event2']);
        });
      });
    });

    describe('Tag Indexing', () => {
      it('should limit indexed tags to MAX_INDEXED_TAGS', async () => {
        // 150 個のタグを持つイベント（MAX_INDEXED_TAGS = 100 を超える）
        const manyTags = Array.from({ length: 150 }, (_, i) => ['p', `pubkey${i}`]);
        await storage.saveEvent({ ...mockEvent, id: 'many-tags-event', tags: manyTags });

        // 元のタグは全て保持されているべき
        const result = await storage.getEvents([{ ids: ['many-tags-event'] }]);
        expect(result[0].tags.length).toBe(150);

        // indexed_tags は 100 に制限される: 100 番目は検索可能、101 番目以降は不可
        expect(await storage.getEvents([{ '#p': ['pubkey99'] }])).toHaveLength(1);
        expect(await storage.getEvents([{ '#p': ['pubkey120'] }])).toHaveLength(0);
      });

      it('should index both priority and non-priority tag types', async () => {
        const mixedTags = [
          ['x', 'value1'], // 非優先タグ
          ['e', 'event1'], // 優先タグ
          ['y', 'value2'],
          ['p', 'pubkey1'], // 優先タグ
          ['z', 'value3'],
          ['a', 'value4'], // 優先タグ
        ];
        await storage.saveEvent({ ...mockEvent, id: 'mixed-tags-event', tags: mixedTags });

        const searches = await Promise.all(
          [
            { '#e': ['event1'] },
            { '#p': ['pubkey1'] },
            { '#a': ['value4'] },
            { '#x': ['value1'] },
            { '#y': ['value2'] },
            { '#z': ['value3'] },
          ].map((filter) => storage.getEvents([filter]))
        );

        for (const result of searches) {
          expect(result.map((e) => e.id)).toEqual(['mixed-tags-event']);
        }
      });

      it('should handle invalid tag formats', async () => {
        const invalidTags = [
          [], // 空配列
          [''], // 空文字列
          ['abc', 'value'], // 2 文字以上のキー
          ['1', 'value'], // 数字のキー
          ['@', 'value'], // 特殊文字のキー
          ['p'], // 値なし
        ];
        await storage.saveEvent({ ...mockEvent, id: 'invalid-tags-event', tags: invalidTags });

        // イベント自体は保存され、タグもそのまま保持される
        const result = await storage.getEvents([{ ids: ['invalid-tags-event'] }]);
        expect(result).toHaveLength(1);
        expect(result[0].tags).toEqual(invalidTags);

        // 無効なタグでの検索は何も返さない
        const searches = await Promise.all(
          [
            { '#': [''] },
            { '#abc': ['value'] },
            { '#1': ['value'] },
            { '#@': ['value'] },
            { '#p': [''] },
          ].map((filter) => storage.getEvents([filter]))
        );

        for (const result of searches) {
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
        await storage.saveEvent(eventWithId('test-id-2'));

        expect(await storage.count()).toBe(2);
      });

      it('should not double-count an event saved twice with the same id', async () => {
        await storage.saveEvent(mockEvent);
        await storage.saveEvent(mockEvent);

        expect(await storage.count()).toBe(1);
      });
    });

    describe('enforceLimit (storageMaxSize / cacheStrategy)', () => {
      it('should not evict while at or under maxSize', async () => {
        await storage.saveEvent(eventAt('a', 1));
        await storage.saveEvent(eventAt('b', 2));
        await storage.saveEvent(eventAt('c', 3));

        expect(await storage.enforceLimit(3)).toBe(0);
        expect(await storage.count()).toBe(3);
      });

      it('should evict the oldest events (FIFO) when exceeding maxSize', async () => {
        await storage.saveEvent(eventAt('oldest', 100));
        await storage.saveEvent(eventAt('middle', 200));
        await storage.saveEvent(eventAt('newest', 300));

        expect(await storage.enforceLimit(2)).toBe(1);
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

        expect(await storage.enforceLimit(2, 'LRU')).toBe(1);
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

        expect(await storage.enforceLimit(2, 'LFU')).toBe(1);
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

        expect(await storage.enforceLimit(1, 'LFU')).toBe(1);
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

        expect(await storage.enforceLimit(1, 'LFU')).toBe(1);
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

        expect(await storage.enforceLimit(1, 'LFU')).toBe(1);
        const remaining = await storage.getEvents([{ kinds: [1] }]);
        expect(remaining[0].id).toBe('x');
        nowSpy.mockRestore();
      });
    });

    const PRIORITY_PUBKEY = 'a'.repeat(64);

    describe('enforceLimit (cachePriority)', () => {
      it('should evict non-priority events before priority-pubkey events (FIFO)', async () => {
        await storage.saveEvent(eventBy('priority-old', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('plain-mid', 200, 'other-pubkey'));
        await storage.saveEvent(eventBy('plain-new', 300, 'other-pubkey'));

        // FIFO 順では 'priority-old' が先頭だが、優先設定により 'plain-mid' が退避される
        expect(await storage.enforceLimit(2, 'FIFO', { pubkeys: [PRIORITY_PUBKEY] })).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['plain-new', 'priority-old']);
      });

      it('should evict non-priority events before priority-kind events (FIFO)', async () => {
        await storage.saveEvent(eventBy('profile-old', 100, 'any-pubkey', 0));
        await storage.saveEvent(eventBy('note-mid', 200, 'any-pubkey', 1));
        await storage.saveEvent(eventBy('note-new', 300, 'any-pubkey', 1));

        expect(await storage.enforceLimit(2, 'FIFO', { kinds: [0] })).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [0, 1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['note-new', 'profile-old']);
      });

      it('should evict priority events in strategy order once only they remain', async () => {
        await storage.saveEvent(eventBy('p-old', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('p-mid', 200, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('p-new', 300, PRIORITY_PUBKEY));

        // 優先イベントしかないので通常の FIFO 順で退避され、maxSize は厳守される
        expect(await storage.enforceLimit(2, 'FIFO', { pubkeys: [PRIORITY_PUBKEY] })).toBe(1);
        expect(await storage.count()).toBe(2);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['p-mid', 'p-new']);
      });

      it('should evict all non-priority events first, then fall back to priority events', async () => {
        await storage.saveEvent(eventBy('p-old', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('p-new', 200, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('plain', 300, 'other-pubkey'));

        // excess 2: 非優先 'plain' + FIFO 先頭の優先 'p-old' が退避される
        expect(await storage.enforceLimit(1, 'FIFO', { pubkeys: [PRIORITY_PUBKEY] })).toBe(2);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id);
        expect(remaining).toEqual(['p-new']);
      });

      it('should keep priority events under LRU while evicting non-priority ones', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await storage.saveEvent(eventBy('priority-stale', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('plain-a', 200, 'other-pubkey'));
        await storage.saveEvent(eventBy('plain-b', 300, 'other-pubkey'));

        // 'plain-a' だけ読み出しておく → LRU 先頭は 'priority-stale'、次点 'plain-b'
        nowSpy.mockReturnValue(2_000_000);
        await storage.getEvents([{ ids: ['plain-a'] }]);

        // LRU 先頭の 'priority-stale' は保護され、非優先の 'plain-b' が退避される
        expect(await storage.enforceLimit(2, 'LRU', { pubkeys: [PRIORITY_PUBKEY] })).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['plain-a', 'priority-stale']);
        nowSpy.mockRestore();
      });

      it('should not evict while at or under maxSize even with priority rules', async () => {
        await storage.saveEvent(eventBy('a', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('b', 200, 'other-pubkey'));

        expect(await storage.enforceLimit(2, 'FIFO', { pubkeys: [PRIORITY_PUBKEY] })).toBe(0);
        expect(await storage.count()).toBe(2);
      });

      it('should keep priority events under LFU while evicting non-priority ones', async () => {
        await storage.saveEvent(eventBy('priority-cold', 100, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('plain-warm', 200, 'other-pubkey'));
        await storage.saveEvent(eventBy('plain-hot', 300, 'other-pubkey'));

        // access_count: priority-cold=1（挿入のみ）, plain-warm=2, plain-hot=3
        await storage.getEvents([{ ids: ['plain-warm'] }]);
        await storage.getEvents([{ ids: ['plain-hot'] }]);
        await storage.getEvents([{ ids: ['plain-hot'] }]);

        // LFU 先頭（access_count 最小）の 'priority-cold' は保護され、非優先で
        // 最も読まれていない 'plain-warm' が退避される
        expect(await storage.enforceLimit(2, 'LFU', { pubkeys: [PRIORITY_PUBKEY] })).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['plain-hot', 'priority-cold']);
      });
    });

    describe('deleteEventsByIdsForPubkey (NIP-09 e tags)', () => {
      const AUTHOR = 'a'.repeat(64);
      const OTHER_AUTHOR = 'b'.repeat(64);

      const event = (id: string, pubkey = AUTHOR, kind = 1): NostrEvent => ({
        id,
        pubkey,
        created_at: 1000,
        kind,
        tags: [],
        content: 'content',
        sig: 'sig',
      });

      it('should delete the referenced events of that author', async () => {
        await storage.saveEvent(event('one'));
        await storage.saveEvent(event('two'));
        await storage.saveEvent(event('three'));

        expect(await storage.deleteEventsByIdsForPubkey(['one', 'three'], AUTHOR)).toBe(2);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id);
        expect(remaining).toEqual(['two']);
      });

      it('should never delete another author’s event', async () => {
        await storage.saveEvent(event('mine'));
        await storage.saveEvent(event('theirs', OTHER_AUTHOR));

        expect(await storage.deleteEventsByIdsForPubkey(['mine', 'theirs'], AUTHOR)).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [1] }])).map((e) => e.id);
        expect(remaining).toEqual(['theirs']);
      });

      it('should never delete a deletion request', async () => {
        // NIP-09: 削除リクエストに対する削除リクエストは効果を持たない
        await storage.saveEvent(event('earlier-deletion', AUTHOR, 5));

        expect(await storage.deleteEventsByIdsForPubkey(['earlier-deletion'], AUTHOR)).toBe(0);
        expect(await storage.count()).toBe(1);
      });

      it('should ignore ids that are not stored', async () => {
        await storage.saveEvent(event('stored'));

        expect(await storage.deleteEventsByIdsForPubkey(['stored', 'missing'], AUTHOR)).toBe(1);
      });

      it('should delete replaceable and addressable events referenced by id', async () => {
        // e タグは kind を問わず id で指す（a タグのような座標制限は無い）
        await storage.saveEvent(event('profile', AUTHOR, 0));
        await storage.saveEvent(event('article', AUTHOR, 30023));

        expect(await storage.deleteEventsByIdsForPubkey(['profile', 'article'], AUTHOR)).toBe(2);
        expect(await storage.count()).toBe(0);
      });

      it('should return 0 for an empty id list', async () => {
        await storage.saveEvent(event('stored'));

        expect(await storage.deleteEventsByIdsForPubkey([], AUTHOR)).toBe(0);
        expect(await storage.count()).toBe(1);
      });
    });

    describe('deleteEventsByAddress (NIP-09 a tags)', () => {
      const AUTHOR = 'a'.repeat(64);
      const OTHER_AUTHOR = 'b'.repeat(64);

      const versioned = (
        id: string,
        createdAt: number,
        kind = 30023,
        // null で「d タグを持たないイベント」を作る（undefined は既定値に化ける）
        identifier: string | null = 'slug',
        pubkey = AUTHOR
      ): NostrEvent => ({
        id,
        pubkey,
        created_at: createdAt,
        kind,
        tags: identifier === null ? [] : [['d', identifier]],
        content: 'content',
        sig: 'sig',
      });

      it('should delete every version up to and including the request time', async () => {
        await storage.saveEvent(versioned('v1', 100));
        await storage.saveEvent(versioned('v2', 200));
        await storage.saveEvent(versioned('v3', 300));

        const removed = await storage.deleteEventsByAddress(
          { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
          200
        );

        // created_at <= until のみ削除。リクエストより後の版 (v3) は残る
        expect(removed).toBe(2);
        const remaining = (await storage.getEvents([{ kinds: [30023] }])).map((e) => e.id);
        expect(remaining).toEqual(['v3']);
      });

      it('should only delete versions with a matching d tag', async () => {
        await storage.saveEvent(versioned('target', 100, 30023, 'slug'));
        await storage.saveEvent(versioned('other-slug', 100, 30023, 'another'));

        const removed = await storage.deleteEventsByAddress(
          { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
          1000
        );

        expect(removed).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [30023] }])).map((e) => e.id);
        expect(remaining).toEqual(['other-slug']);
      });

      it('should ignore the d tag for replaceable kinds', async () => {
        await storage.saveEvent(versioned('profile', 100, 0, 'ignored'));

        const removed = await storage.deleteEventsByAddress(
          { kind: 0, pubkey: AUTHOR, identifier: '' },
          1000
        );

        expect(removed).toBe(1);
      });

      it('should never delete another author’s versions', async () => {
        await storage.saveEvent(versioned('mine', 100));
        await storage.saveEvent(versioned('theirs', 100, 30023, 'slug', OTHER_AUTHOR));

        const removed = await storage.deleteEventsByAddress(
          { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
          1000
        );

        expect(removed).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [30023] }])).map((e) => e.id);
        expect(remaining).toEqual(['theirs']);
      });

      it('should treat a missing d tag as the empty identifier', async () => {
        await storage.saveEvent(versioned('no-d-tag', 100, 30023, null));

        const removed = await storage.deleteEventsByAddress(
          { kind: 30023, pubkey: AUTHOR, identifier: '' },
          1000
        );

        expect(removed).toBe(1);
        expect(await storage.count()).toBe(0);
      });

      it('should never delete deletion requests', async () => {
        await storage.saveEvent(versioned('a-deletion', 100, 5, 'slug'));

        const removed = await storage.deleteEventsByAddress(
          { kind: 5, pubkey: AUTHOR, identifier: 'slug' },
          1000
        );

        expect(removed).toBe(0);
        expect(await storage.count()).toBe(1);
      });

      it('should refuse a coordinate naming a regular kind', async () => {
        // 公開メソッドなので、解析段階のガードとは別にここでも防ぐ
        await storage.saveEvent(versioned('note', 100, 1, null));

        const removed = await storage.deleteEventsByAddress(
          { kind: 1, pubkey: AUTHOR, identifier: '' },
          1000
        );

        expect(removed).toBe(0);
        expect(await storage.count()).toBe(1);
      });

      it('should refuse a non-finite until bound', async () => {
        await storage.saveEvent(versioned('v1', 100));

        const removed = await storage.deleteEventsByAddress(
          { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
          Number.NaN
        );

        expect(removed).toBe(0);
        expect(await storage.count()).toBe(1);
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

        // 'old' (cached before 200s) deleted; 'boundary' (==200s) and 'fresh' kept
        expect(await storage.deleteExpired(200)).toBe(1);
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

        expect(await storage.deleteExpired(300)).toBe(1);
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

      it('should retain expired priority events and delete expired non-priority ones', async () => {
        const nowSpy = vi.spyOn(Date, 'now');
        nowSpy.mockReturnValue(100_000);
        await storage.saveEvent(eventBy('priority-expired', 1, PRIORITY_PUBKEY));
        await storage.saveEvent(eventBy('profile-expired', 2, 'other-pubkey', 0));
        await storage.saveEvent(eventBy('plain-expired', 3, 'other-pubkey'));
        nowSpy.mockReturnValue(300_000);
        await storage.saveEvent(eventBy('plain-fresh', 4, 'other-pubkey'));
        nowSpy.mockRestore();

        // 期限切れ 3 件のうち優先（pubkey / kind 0）の 2 件は保持される
        const removed = await storage.deleteExpired(200, {
          pubkeys: [PRIORITY_PUBKEY],
          kinds: [0],
        });

        expect(removed).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [0, 1] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['plain-fresh', 'priority-expired', 'profile-expired']);
      });
    });

    describe('retention of deletion requests (NIP-09)', () => {
      it('should keep expired deletion requests out of the TTL sweep', async () => {
        // 削除リクエストが先に消えると、対象イベントが再取得されたときに
        // 再適用する手段が失われる
        const nowSpy = vi.spyOn(Date, 'now');
        nowSpy.mockReturnValue(100_000);
        await storage.saveEvent(eventOfKind('deletion', 5, 1));
        await storage.saveEvent(eventOfKind('note', 1, 1));
        nowSpy.mockRestore();

        expect(await storage.deleteExpired(200)).toBe(1);
        expect((await storage.getEvents([{ kinds: [1, 5] }])).map((e) => e.id)).toEqual([
          'deletion',
        ]);
      });

      it('should evict deletion requests last under storageMaxSize', async () => {
        await storage.saveEvent(eventOfKind('deletion', 5, 1));
        await storage.saveEvent(eventOfKind('old-note', 1, 2));
        await storage.saveEvent(eventOfKind('new-note', 1, 3));

        // FIFO なら created_at 最小の 'deletion' が最初に退避されるはずだが、
        // 常時保持の kind なので非優先の 'old-note' が先に退避される
        expect(await storage.enforceLimit(2, 'FIFO')).toBe(1);
        const remaining = (await storage.getEvents([{ kinds: [1, 5] }])).map((e) => e.id).sort();
        expect(remaining).toEqual(['deletion', 'new-note']);
      });

      it('should still honor storageMaxSize when only deletion requests remain', async () => {
        await storage.saveEvent(eventOfKind('deletion-1', 5, 1));
        await storage.saveEvent(eventOfKind('deletion-2', 5, 2));
        await storage.saveEvent(eventOfKind('deletion-3', 5, 3));

        // 保持は best-effort。退避できるものが他に無ければ maxSize が優先される
        expect(await storage.enforceLimit(2, 'FIFO')).toBe(1);
        expect(await storage.count()).toBe(2);
      });
    });
  });
}
