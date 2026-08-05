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
import { DexieStorage } from './dexie-storage.js';

const createStorage = () => new DexieStorage('TestNostrCacheRelay');

/** テスト間で IndexedDB を持ち越さない */
const disposeStorage = async (storage: DexieStorage) => {
  await storage.clear();
  await storage.delete();
  // Reset indexedDB for next test
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
});
