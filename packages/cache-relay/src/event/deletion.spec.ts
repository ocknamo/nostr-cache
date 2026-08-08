/** Tests for the NIP-09 deletion request helpers */

import type { NostrEvent } from '@nostr-cache/shared';
import { type Mocked, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import {
  MAX_DELETION_REFERENCES,
  applyDeletionRequest,
  isDeletableAddress,
  isDeletionEvent,
  matchesAddressIdentifier,
  parseAddress,
  parseDeletionRequest,
} from './deletion.js';

const AUTHOR = 'a'.repeat(64);
const OTHER_AUTHOR = 'b'.repeat(64);
const TARGET_ID = '1'.repeat(64);
const OTHER_TARGET_ID = '2'.repeat(64);

/** Build a kind 5 deletion request authored by `pubkey`. */
function deletionRequest(tags: string[][], pubkey = AUTHOR, createdAt = 1000): NostrEvent {
  return {
    id: 'deletion-id',
    pubkey,
    created_at: createdAt,
    kind: 5,
    tags,
    content: '',
    sig: 'sig',
  };
}

describe('isDeletionEvent', () => {
  it('should recognize kind 5 only', () => {
    expect(isDeletionEvent({ kind: 5 })).toBe(true);
    expect(isDeletionEvent({ kind: 1 })).toBe(false);
    expect(isDeletionEvent({ kind: 30023 })).toBe(false);
  });
});

describe('parseAddress', () => {
  it('should parse a coordinate', () => {
    expect(parseAddress(`30023:${AUTHOR}:my-article`)).toEqual({
      kind: 30023,
      pubkey: AUTHOR,
      identifier: 'my-article',
    });
  });

  it('should parse a replaceable coordinate with an empty identifier', () => {
    expect(parseAddress(`0:${AUTHOR}:`)).toEqual({
      kind: 0,
      pubkey: AUTHOR,
      identifier: '',
    });
  });

  it('should keep colons inside the identifier', () => {
    expect(parseAddress(`30023:${AUTHOR}:a:b:c`)?.identifier).toBe('a:b:c');
  });

  it('should reject malformed coordinates', () => {
    // 区切りが足りない / kind が数字でない / pubkey が hex 64 桁でない
    expect(parseAddress(`30023:${AUTHOR}`)).toBeUndefined();
    expect(parseAddress(AUTHOR)).toBeUndefined();
    expect(parseAddress(`:${AUTHOR}:x`)).toBeUndefined();
    expect(parseAddress(`abc:${AUTHOR}:x`)).toBeUndefined();
    expect(parseAddress(`1.5:${AUTHOR}:x`)).toBeUndefined();
    expect(parseAddress(` 1:${AUTHOR}:x`)).toBeUndefined();
    expect(parseAddress('30023:short-pubkey:x')).toBeUndefined();
    expect(parseAddress(`30023:${AUTHOR.toUpperCase()}:x`)).toBeUndefined();
  });

  it('should reject a kind with leading zeros as a non-canonical coordinate', () => {
    expect(parseAddress(`030023:${AUTHOR}:x`)).toBeUndefined();
    // '0' 単体は正規形
    expect(parseAddress(`0:${AUTHOR}:`)?.kind).toBe(0);
  });
});

describe('isDeletableAddress', () => {
  it('should accept replaceable and addressable coordinates', () => {
    for (const kind of [0, 3, 10002, 30023]) {
      expect(isDeletableAddress({ kind, pubkey: AUTHOR, identifier: '' }, 1000)).toBe(true);
    }
  });

  it('should reject coordinates that cannot address an event', () => {
    // 通常 kind を通すと「この著者の kind 1 を全部削除」になる。kind 5 は
    // 座標で指せる kind ではないので同じ判定で落ちる
    for (const kind of [1, 5, 20001]) {
      expect(isDeletableAddress({ kind, pubkey: AUTHOR, identifier: '' }, 1000)).toBe(false);
    }
  });

  it('should reject a non-finite until bound', () => {
    const address = { kind: 30023, pubkey: AUTHOR, identifier: 'slug' };
    expect(isDeletableAddress(address, Number.NaN)).toBe(false);
    expect(isDeletableAddress(address, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isDeletableAddress(address, 'x' as unknown as number)).toBe(false);
  });
});

describe('parseDeletionRequest', () => {
  it('should collect e tag ids and the request created_at', () => {
    const request = parseDeletionRequest(
      deletionRequest([
        ['e', TARGET_ID],
        ['e', OTHER_TARGET_ID],
      ])
    );

    expect(request.pubkey).toBe(AUTHOR);
    expect(request.ids).toEqual([TARGET_ID, OTHER_TARGET_ID]);
    expect(request.until).toBe(1000);
  });

  it('should deduplicate repeated references', () => {
    const request = parseDeletionRequest(
      deletionRequest([
        ['e', TARGET_ID],
        ['e', TARGET_ID],
        ['a', `30023:${AUTHOR}:slug`],
        ['a', `30023:${AUTHOR}:slug`],
      ])
    );

    expect(request.ids).toEqual([TARGET_ID]);
    expect(request.addresses).toHaveLength(1);
  });

  it('should drop e tags that are not 32-byte hex ids', () => {
    const request = parseDeletionRequest(deletionRequest([['e', 'not-an-id'], ['e', ''], ['e']]));

    expect(request.ids).toEqual([]);
  });

  it('should drop a tags authored by someone else', () => {
    const request = parseDeletionRequest(
      deletionRequest([
        ['a', `30023:${OTHER_AUTHOR}:slug`],
        ['a', `30023:${AUTHOR}:slug`],
      ])
    );

    expect(request.addresses).toEqual([{ kind: 30023, pubkey: AUTHOR, identifier: 'slug' }]);
  });

  it('should drop a tags naming a kind that is not addressed by a coordinate', () => {
    // `1:<pubkey>:` を許すと「この著者の kind 1 を全部削除」になってしまう
    const request = parseDeletionRequest(
      deletionRequest([
        ['a', `1:${AUTHOR}:`],
        ['a', `5:${AUTHOR}:`],
        ['a', `20001:${AUTHOR}:`],
      ])
    );

    expect(request.addresses).toEqual([]);
  });

  it('should accept a tags for replaceable and addressable kinds', () => {
    const request = parseDeletionRequest(
      deletionRequest([
        ['a', `0:${AUTHOR}:`],
        ['a', `3:${AUTHOR}:`],
        ['a', `10002:${AUTHOR}:`],
        ['a', `30023:${AUTHOR}:slug`],
      ])
    );

    expect(request.addresses.map((address) => address.kind)).toEqual([0, 3, 10002, 30023]);
  });

  it('should ignore unrelated tags', () => {
    const request = parseDeletionRequest(
      deletionRequest([
        ['k', '1'],
        ['p', AUTHOR],
        ['e', TARGET_ID],
      ])
    );

    expect(request.ids).toEqual([TARGET_ID]);
    expect(request.addresses).toEqual([]);
  });

  it('should cap references per tag type', () => {
    // 座標 1 件につきストレージ 1 往復なので、1 通で無制限に増幅させない
    const hexId = (index: number) => index.toString(16).padStart(64, '0');
    const tags: string[][] = [];
    for (let index = 0; index < MAX_DELETION_REFERENCES + 10; index++) {
      tags.push(['e', hexId(index)]);
      tags.push(['a', `30023:${AUTHOR}:slug-${index}`]);
    }

    const request = parseDeletionRequest(deletionRequest(tags));

    expect(request.ids).toHaveLength(MAX_DELETION_REFERENCES);
    expect(request.addresses).toHaveLength(MAX_DELETION_REFERENCES);
  });

  it('should not count duplicates against the cap', () => {
    const tags: string[][] = Array.from({ length: MAX_DELETION_REFERENCES + 10 }, () => [
      'e',
      TARGET_ID,
    ]);
    tags.push(['e', OTHER_TARGET_ID]);

    const request = parseDeletionRequest(deletionRequest(tags));

    expect(request.ids).toEqual([TARGET_ID, OTHER_TARGET_ID]);
  });

  it('should tolerate a malformed tags array', () => {
    // NONE モードでは構造が壊れたイベントも到達しうる
    const malformed = {
      ...deletionRequest([]),
      tags: [null, 'not-an-array', ['e', TARGET_ID], []],
    } as unknown as NostrEvent;

    expect(() => parseDeletionRequest(malformed)).not.toThrow();
    expect(parseDeletionRequest(malformed).ids).toEqual([TARGET_ID]);

    const noTags = { ...deletionRequest([]), tags: undefined } as unknown as NostrEvent;
    expect(parseDeletionRequest(noTags).ids).toEqual([]);
  });
});

describe('matchesAddressIdentifier', () => {
  it('should ignore the identifier for replaceable kinds', () => {
    const address = { kind: 0, pubkey: AUTHOR, identifier: '' };
    expect(matchesAddressIdentifier([], address)).toBe(true);
    expect(matchesAddressIdentifier([['d', 'anything']], address)).toBe(true);
  });

  it('should require a matching d tag for addressable kinds', () => {
    const address = { kind: 30023, pubkey: AUTHOR, identifier: 'slug' };
    expect(matchesAddressIdentifier([['d', 'slug']], address)).toBe(true);
    expect(matchesAddressIdentifier([['d', 'other']], address)).toBe(false);
  });

  it('should treat a missing d tag as the empty identifier', () => {
    expect(matchesAddressIdentifier([], { kind: 30023, pubkey: AUTHOR, identifier: '' })).toBe(
      true
    );
    expect(
      matchesAddressIdentifier([['t', 'x']], { kind: 30023, pubkey: AUTHOR, identifier: 'slug' })
    ).toBe(false);
  });
});

describe('applyDeletionRequest', () => {
  let storage: Mocked<StorageAdapter>;

  beforeEach(() => {
    storage = {
      deleteEventsByIdsForPubkey: vi.fn().mockResolvedValue(2),
      deleteEventsByAddress: vi.fn().mockResolvedValue(1),
    } as unknown as Mocked<StorageAdapter>;
  });

  it('should delete referenced ids restricted to the request author', async () => {
    const deleted = await applyDeletionRequest(storage, deletionRequest([['e', TARGET_ID]]));

    expect(storage.deleteEventsByIdsForPubkey).toHaveBeenCalledWith([TARGET_ID], AUTHOR);
    expect(deleted).toBe(2);
  });

  it('should delete each coordinate up to the request created_at', async () => {
    const deleted = await applyDeletionRequest(
      storage,
      deletionRequest([
        ['a', `30023:${AUTHOR}:slug`],
        ['a', `0:${AUTHOR}:`],
      ])
    );

    expect(storage.deleteEventsByAddress).toHaveBeenCalledWith(
      { kind: 30023, pubkey: AUTHOR, identifier: 'slug' },
      1000
    );
    expect(storage.deleteEventsByAddress).toHaveBeenCalledWith(
      { kind: 0, pubkey: AUTHOR, identifier: '' },
      1000
    );
    expect(deleted).toBe(2);
  });

  it('should not touch storage when nothing valid is referenced', async () => {
    const deleted = await applyDeletionRequest(storage, deletionRequest([['k', '1']]));

    expect(storage.deleteEventsByIdsForPubkey).not.toHaveBeenCalled();
    expect(storage.deleteEventsByAddress).not.toHaveBeenCalled();
    expect(deleted).toBe(0);
  });

  it('should swallow a malformed request instead of throwing', async () => {
    // publishEvent は保存をコミットした後に呼ぶため、ここで throw させない
    const malformed = { ...deletionRequest([]), tags: null } as unknown as NostrEvent;

    await expect(applyDeletionRequest(storage, malformed)).resolves.toBe(0);
  });

  it('should swallow storage failures so the stored request can be re-applied', async () => {
    storage.deleteEventsByIdsForPubkey.mockRejectedValue(new Error('storage down'));

    await expect(applyDeletionRequest(storage, deletionRequest([['e', TARGET_ID]]))).resolves.toBe(
      0
    );
  });
});
