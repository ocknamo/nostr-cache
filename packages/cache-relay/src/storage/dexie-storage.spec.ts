/**
 * DexieStorage のテスト。
 *
 * `StorageAdapter` としての振る舞いは共通の適合性テスト
 * （`src/test/storage-conformance.ts`）に委譲し、ここでは Dexie / IndexedDB
 * 固有の観点だけを検証する。
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFORMANCE_MOCK_EVENT,
  describeStorageAdapterConformance,
} from '../test/storage-conformance.js';
import { sortNewestFirst } from '../utils/filter-utils.js';
import { DexieStorage } from './dexie-storage.js';

const createStorage = () => new DexieStorage('TestNostrCacheRelay');

/** テスト間で IndexedDB を持ち越さない */
const disposeStorage = async (storage: DexieStorage) => {
  await storage.clear();
  await storage.delete();
  // @ts-ignore - fake-indexeddb types
  // biome-ignore lint/suspicious/noGlobalAssign: for indexedDB mock
  indexedDB = new IDBFactory();
};

describeStorageAdapterConformance('DexieStorage', {
  create: createStorage,
  dispose: disposeStorage,
  readBookkeeping: async (storage, id) => {
    const row = await storage.table('events').get(id);
    return row && { validated: row.validated === 1, accessCount: row.access_count };
  },
});

describe('DexieStorage (Dexie-specific)', () => {
  let storage: DexieStorage;

  beforeEach(() => {
    storage = createStorage();
  });

  afterEach(async () => {
    await disposeStorage(storage);
  });

  describe('error handling', () => {
    /** IndexedDB がロックされている状況を作る */
    const lockNextQuery = () => {
      // @ts-ignore - private field access for testing
      vi.spyOn(storage.events, 'where').mockImplementationOnce(() => {
        throw new Error('Database is locked');
      });
    };

    it('should return false from deleteEventsByPubkeyAndKind when the query throws', async () => {
      await storage.saveEvent({ ...CONFORMANCE_MOCK_EVENT, kind: 0 });
      lockNextQuery();

      expect(await storage.deleteEventsByPubkeyAndKind(CONFORMANCE_MOCK_EVENT.pubkey, 0)).toBe(
        false
      );
    });

    it('should return false from deleteEventsByPubkeyKindAndDTag when the query throws', async () => {
      await storage.saveEvent({
        ...CONFORMANCE_MOCK_EVENT,
        kind: 30001,
        tags: [['d', 'test1']],
      });
      lockNextQuery();

      expect(
        await storage.deleteEventsByPubkeyKindAndDTag(CONFORMANCE_MOCK_EVENT.pubkey, 30001, 'test1')
      ).toBe(false);
    });

    it('should propagate a getCurrentVersion failure instead of reporting "no version"', async () => {
      // 失敗を undefined（＝未保存）として返すと、置換可能イベントの版比較が
      // 「保存済みの版は無い」と誤り、古い版で新しい版を上書きしてしまう
      await storage.saveEvent({ ...CONFORMANCE_MOCK_EVENT, kind: 0 });
      lockNextQuery();

      await expect(
        storage.getCurrentVersion({
          kind: 0,
          pubkey: CONFORMANCE_MOCK_EVENT.pubkey,
          identifier: '',
        })
      ).rejects.toThrow('Database is locked');
    });
  });

  // `limit` の有無で別々の経路を通るので、切り詰めた結果が「全一致を新しい順に
  // 並べた先頭 N 件」と一致することを縛る（limit 無しの結果はインデックス順の
  // ままなので、比較の前に並べ替える）
  describe('the ordered and unordered plans agree', () => {
    const authors = Array.from({ length: 12 }, (_, i) => `author${i}`);

    beforeEach(async () => {
      for (let i = 0; i < 40; i++) {
        await storage.saveEvent({
          id: `note-${String(i).padStart(2, '0')}`,
          pubkey: authors[i % authors.length],
          // 同時刻を混ぜて、id によるタイブレークも経路間で一致させる
          created_at: 1000 + Math.floor(i / 2),
          kind: i % 3 === 0 ? 7 : 1,
          tags: [],
          content: `note ${i}`,
          sig: 'sig',
        });
      }
    });

    it('should return the same prefix the unlimited query starts with', async () => {
      const filter = { kinds: [1], authors };
      const all = sortNewestFirst(await storage.getEvents([filter]));
      const limited = await storage.getEvents([{ ...filter, limit: 7 }]);

      expect(limited.map((e) => e.id)).toEqual(all.slice(0, 7).map((e) => e.id));
    });

    it('should agree for a multi-kind filter, which reads a cursor per kind', async () => {
      const filter = { kinds: [1, 7], authors };
      const all = sortNewestFirst(await storage.getEvents([filter]));
      const limited = await storage.getEvents([{ ...filter, limit: 9 }]);

      expect(limited.map((e) => e.id)).toEqual(all.slice(0, 9).map((e) => e.id));
    });

    it('should agree when the limit exceeds the number of matches', async () => {
      const filter = { kinds: [1], authors: [authors[0]] };
      const all = sortNewestFirst(await storage.getEvents([filter]));
      const limited = await storage.getEvents([{ ...filter, limit: 500 }]);

      expect(limited.map((e) => e.id)).toEqual(all.map((e) => e.id));
    });
  });
});
