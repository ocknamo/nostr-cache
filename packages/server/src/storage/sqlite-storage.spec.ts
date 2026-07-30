/**
 * SqliteStorage のテスト。
 *
 * `StorageAdapter` としての振る舞いは cache-relay と共有する適合性テスト
 * （`@nostr-cache/cache-relay/test/storage-conformance`）に委譲し、DexieStorage と
 * 同一のセマンティクスを持つことを検証する。ここでは SQLite 固有の観点
 * （ファイル永続化・close 後の安全なフォールバック・チャンク分割）だけを扱う。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as nodeSqlite from 'node:sqlite';
import {
  describeStorageAdapterConformance,
  CONFORMANCE_MOCK_EVENT as mockEvent,
} from '@nostr-cache/cache-relay/test/storage-conformance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from './sqlite-storage.js';

// ブックキーピング列を検証するための private client（生の DatabaseSync）アクセス
type WithClient = { client: nodeSqlite.DatabaseSync };

const rawQuery = <T>(storage: SqliteStorage, sql: string, ...params: string[]): T | undefined =>
  (storage as unknown as WithClient).client.prepare(sql).get(...params) as T | undefined;

describeStorageAdapterConformance('SqliteStorage', {
  create: () => new SqliteStorage(':memory:'),
  dispose: (storage) => storage.close(),
  readBookkeeping: (storage, id) => {
    const row = rawQuery<{ validated: number; access_count: number }>(
      storage,
      'SELECT validated, access_count FROM events WHERE id = ?',
      id
    );
    return row && { validated: row.validated === 1, accessCount: row.access_count };
  },
});

describe('SqliteStorage (SQLite-specific)', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  // SQLite のバインドパラメータ上限を超える id 数でも 1 回の呼び出しで扱えること
  describe('id chunking', () => {
    const BULK_IDS = Array.from({ length: 1200 }, (_, i) => `bulk-${i}`);

    const saveBulk = async () => {
      for (const id of BULK_IDS) {
        await storage.saveEvent({ ...mockEvent, id });
      }
    };

    it('should look up more ids than the chunk size in one getCachedAt call', async () => {
      await saveBulk();

      expect((await storage.getCachedAt(BULK_IDS)).size).toBe(BULK_IDS.length);
    });

    it('should re-stamp more ids than the chunk size in one touchCachedAt call', async () => {
      await saveBulk();

      expect(await storage.touchCachedAt(BULK_IDS)).toBe(BULK_IDS.length);
    });
  });

  // close 済みの DB への操作は投げずにフォールバック値を返す（server の
  // stop() → start() が既定モードと対称に振る舞うための前提）。
  // 失敗時の切り分けができるよう、読み・書き・void 返しで分けて検証する。
  describe('error fallbacks after close', () => {
    beforeEach(async () => {
      await storage.saveEvent(mockEvent);
      storage.close();
    });

    it('should return empty results from reads', async () => {
      expect(await storage.getEvents([{ ids: [mockEvent.id] }])).toEqual([]);
      expect(await storage.getUnvalidatedEvents(10)).toEqual([]);
      expect((await storage.getValidationStatus([mockEvent.id])).get(mockEvent.id)).toBe('unknown');
      expect(await storage.count()).toBe(0);
      expect((await storage.getCachedAt([mockEvent.id])).size).toBe(0);
    });

    it('should report failure from writes and deletions', async () => {
      expect(await storage.saveEvent({ ...mockEvent, id: 'other' })).toBe(false);
      expect(await storage.deleteEvent(mockEvent.id)).toBe(false);
      expect(await storage.deleteEventsByPubkeyAndKind(mockEvent.pubkey, mockEvent.kind)).toBe(
        false
      );
      expect(await storage.deleteEventsByPubkeyKindAndDTag(mockEvent.pubkey, 30001, 'd')).toBe(
        false
      );
      expect(await storage.deleteExpired(999_999_999)).toBe(0);
      expect(await storage.enforceLimit(1)).toBe(0);
      expect(await storage.touchCachedAt([mockEvent.id])).toBe(0);
    });

    it('should not throw from the void-returning methods', async () => {
      await expect(storage.markValidated([mockEvent.id])).resolves.toBeUndefined();
      await expect(storage.clear()).resolves.toBeUndefined();
    });
  });

  describe('file persistence', () => {
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
      const persistent = new SqliteStorage(join(dataDir, 'nested', 'dirs', 'relay.db'));
      expect(await persistent.saveEvent(mockEvent)).toBe(true);
      persistent.close();
    });

    it('should reopen the same instance after close via open()', async () => {
      const persistent = new SqliteStorage(join(dataDir, 'relay.db'));
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
});
