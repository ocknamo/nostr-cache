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
import { DexieStorage, readNewest } from './dexie-storage.js';
import type { NostrEventTable } from './dexie/schema.js';

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

/**
 * Stand-in for a descending Dexie collection that records how far the walk got.
 *
 * Reproduces the two behaviours `readNewest` depends on: filters run **in the
 * order they were chained** and **short-circuit**, and `until` stops the walk at
 * the first row it accepts, excluding that row (dexie 4.4.4 `combine()` /
 * `addFilter()` / `Collection.until`).
 */
function descendingCollection(rows: NostrEventTable[]) {
  const chain: ((row: NostrEventTable) => boolean)[] = [];
  let scanned = 0;
  let stopped = false;

  const collection = {
    until(stop: (row: NostrEventTable) => boolean) {
      chain.push((row) => {
        if (stop(row)) {
          stopped = true;
          return false;
        }
        return true;
      });
      return collection;
    },
    filter(keep: (row: NostrEventTable) => boolean) {
      chain.push(keep);
      return collection;
    },
    async each(visit: (row: NostrEventTable) => void) {
      for (const row of rows) {
        // 「カーソルが読んだ行数」。打ち切りを判定した行も読んではいる
        scanned++;
        const kept = chain.every((link) => link(row));
        if (stopped) {
          return;
        }
        if (kept) {
          visit(row);
        }
      }
    },
    get scanned() {
      return scanned;
    },
  };
  return collection;
}

describe('readNewest', () => {
  const row = (i: number, matching: boolean): NostrEventTable =>
    ({
      id: `row-${String(i).padStart(3, '0')}`,
      pubkey: matching ? 'wanted' : 'other',
      created_at: 10_000 - i,
      kind: 1,
    }) as NostrEventTable;

  it('stops walking once the limit is met, even if no later row matches', () => {
    // 鎖の順序が逆でも**結果は正しいまま**（切り詰めは capEvents が行う）で、
    // 早期打ち切りだけが静かに効かなくなる。結果を見るテストでは捕まらないので、
    // 走査した行数そのものを縛る
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i, true)),
      ...Array.from({ length: 200 }, (_, i) => row(i + 5, false)),
    ];
    const collection = descendingCollection(rows);

    return readNewest(collection as never, (candidate) => candidate.pubkey === 'wanted', 5).then(
      (found) => {
        expect(found.map((e) => e.id)).toEqual(rows.slice(0, 5).map((e) => e.id));
        // 5 件そろった次の行で打ち切られる
        expect(collection.scanned).toBe(6);
      }
    );
  });

  it('keeps reading while the boundary timestamp continues', async () => {
    // 同着は id 昇順で切るため、境界と同時刻の行は一致・不一致にかかわらず
    // 読み切ってからでないと切り詰められない
    const tied = [row(0, true), row(1, true), { ...row(2, true), created_at: 9_999 }];
    const rows = [...tied, { ...row(3, true), created_at: 9_999 }, row(4, true)];
    const collection = descendingCollection(rows);

    const found = await readNewest(collection as never, () => true, 3);

    expect(found.map((e) => e.id)).toEqual(['row-000', 'row-001', 'row-002', 'row-003']);
    expect(collection.scanned).toBe(5);
  });
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

  // `limit` の有無でクエリプランが変わる（有ると created_at 降順で走査して
  // 打ち切る）。両者が別々の経路である以上、切り詰めた結果が「全一致を新しい順に
  // 並べた先頭 N 件」と一致することは明示的に縛る（limit 無しの結果は
  // インデックス順のままなので、比較の前に共通の規則で並べ替える）
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
