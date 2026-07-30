/**
 * `StorageAdapter` のテスト用モック。
 *
 * 実ストレージを使わないユニットテストが、15 個近いメソッドの `vi.fn()` を
 * 各 spec で書き写さずに済むようにする。
 *
 * 生成するのは **必須メソッドのみ**。`getCachedAt` / `touchCachedAt` /
 * `deleteExpired` / `enforceLimit` は任意のケイパビリティで、実装するかどうかが
 * リレー側の分岐（フレッシュネス窓・TTL 掃除・上限退避）を切り替えるため、
 * 必要なテストが `overrides` で明示的に足す。
 */

import { type Mock, vi } from 'vitest';
import type { StorageAdapter } from '../../storage/storage-adapter.js';

/** 全メソッドが `Mock` として参照できる `StorageAdapter` */
export type MockStorage = { [K in keyof Required<StorageAdapter>]: Mock } & StorageAdapter;

export function createMockStorage(overrides: Partial<MockStorage> = {}): MockStorage {
  return {
    saveEvent: vi.fn().mockResolvedValue(true),
    getEvents: vi.fn().mockResolvedValue([]),
    deleteEvent: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
    deleteEventsByIdsForPubkey: vi.fn().mockResolvedValue(0),
    deleteEventsByAddress: vi.fn().mockResolvedValue(0),
    getUnvalidatedEvents: vi.fn().mockResolvedValue([]),
    markValidated: vi.fn().mockResolvedValue(undefined),
    getValidationStatus: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as MockStorage;
}
