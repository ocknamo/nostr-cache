/**
 * Tests for the NIP-01 replaceable / addressable version comparison.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { addressOf, getDTagValue, selectCurrentVersion, supersedes } from './replaceable.js';

describe('replaceable', () => {
  const event = (id: string, created_at: number, overrides: Partial<NostrEvent> = {}): NostrEvent =>
    ({
      id,
      pubkey: 'author',
      created_at,
      kind: 0,
      tags: [],
      content: '',
      sig: 'sig',
      ...overrides,
    }) as NostrEvent;

  describe('getDTagValue', () => {
    it('should return the d tag value', () => {
      expect(
        getDTagValue([
          ['e', 'x'],
          ['d', 'slug'],
        ])
      ).toBe('slug');
    });

    it('should return the first d tag when several are present', () => {
      expect(
        getDTagValue([
          ['d', 'first'],
          ['d', 'second'],
        ])
      ).toBe('first');
    });

    it('should return undefined without a d tag', () => {
      expect(getDTagValue([['e', 'x']])).toBeUndefined();
    });

    it('should return undefined for a d tag without a value', () => {
      // 値を持たない ['d'] は「d タグ無し」と同じ扱い。座標としては
      // addressOf が空識別子に落とすので matchesAddressIdentifier と揃う
      expect(getDTagValue([['d']])).toBeUndefined();
      expect(addressOf({ ...event('a', 1, { kind: 30023, tags: [['d']] }) }).identifier).toBe('');
    });
  });

  describe('addressOf', () => {
    it('should leave the identifier empty for replaceable kinds', () => {
      // 置換可能 kind の座標に d は含まれない（あっても無視される）
      expect(addressOf(event('a', 1, { kind: 0, tags: [['d', 'ignored']] }))).toEqual({
        kind: 0,
        pubkey: 'author',
        identifier: '',
      });
    });

    it('should use the d tag for addressable kinds', () => {
      expect(addressOf(event('a', 1, { kind: 30023, tags: [['d', 'slug']] }))).toEqual({
        kind: 30023,
        pubkey: 'author',
        identifier: 'slug',
      });
    });

    it('should treat a missing d tag as the empty identifier', () => {
      expect(addressOf(event('a', 1, { kind: 30023 })).identifier).toBe('');
    });
  });

  describe('supersedes', () => {
    it('should keep the stored version when it is newer', () => {
      expect(supersedes(event('stored', 2000), event('incoming', 1000))).toBe(true);
    });

    it('should not keep the stored version when the incoming one is newer', () => {
      expect(supersedes(event('stored', 1000), event('incoming', 2000))).toBe(false);
    });

    it('should break a created_at tie by the lowest id', () => {
      expect(supersedes(event('aaaa', 1000), event('bbbb', 1000))).toBe(true);
      expect(supersedes(event('bbbb', 1000), event('aaaa', 1000))).toBe(false);
    });

    it('should never supersede the same event', () => {
      // 同一 id は「古い版」ではなく同じイベント。再保存経路をそのまま通す
      expect(supersedes(event('same', 1000), event('same', 1000))).toBe(false);
    });
  });

  describe('selectCurrentVersion', () => {
    it('should return undefined for no versions', () => {
      expect(selectCurrentVersion([])).toBeUndefined();
    });

    it('should return the newest version', () => {
      const newest = event('c', 3000);
      expect(selectCurrentVersion([event('a', 1000), newest, event('b', 2000)])).toBe(newest);
    });

    it('should return the lowest id among versions sharing created_at', () => {
      const lowest = event('aaaa', 1000);
      expect(selectCurrentVersion([event('cccc', 1000), lowest, event('bbbb', 1000)])).toBe(lowest);
    });

    it('should not depend on the input order', () => {
      const versions = [event('bbbb', 2000), event('aaaa', 2000), event('zzzz', 1000)];
      const winner = selectCurrentVersion(versions)?.id;
      expect(winner).toBe('aaaa');
      expect(selectCurrentVersion([...versions].reverse())?.id).toBe(winner);
    });
  });
});
