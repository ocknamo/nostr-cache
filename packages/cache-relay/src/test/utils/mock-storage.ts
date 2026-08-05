/**
 * `StorageAdapter` のテスト用モック。
 *
 * 実ストレージを使わないユニットテストが、15 個近いメソッドの `vi.fn()` を
 * 各 spec で書き写さずに済むようにする。
 *
 * 生成するのは **必須メソッドのみ**。任意のケイパビリティは実装するかどうかが
 * リレー側の分岐（フレッシュネス窓・TTL 掃除・上限退避）を切り替えるため、
 * 必要なテストが `overrides` で明示的に足す。型もそれを反映して、足していない
 * ケイパビリティは optional のまま（存在すると偽らない）。
 */

import { type Mock, vi } from 'vitest';
import type { StorageAdapter } from '../../storage/storage-adapter.js';

/** 実装が任意で、有無そのものがリレーの挙動を変えるケイパビリティ */
type OptionalCapability = 'getCachedAt' | 'touchCachedAt' | 'deleteExpired' | 'enforceLimit';

/**
 * 必須メソッドは常に `Mock`、任意ケイパビリティは `overrides` で渡したときだけ
 * 存在する `StorageAdapter`。
 */
export type MockStorage = StorageAdapter & {
  [K in Exclude<keyof StorageAdapter, OptionalCapability>]: Mock;
} & { [K in OptionalCapability]?: Mock };

export function createMockStorage(overrides: Partial<MockStorage> = {}): MockStorage {
  return {
    saveEvent: vi.fn().mockResolvedValue(true),
    getEvents: vi.fn().mockResolvedValue([]),
    // 既定は「その座標にはまだ何も保存されていない」= 置換可能イベントは常に保存される
    getCurrentVersion: vi.fn().mockResolvedValue(undefined),
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
  };
}
