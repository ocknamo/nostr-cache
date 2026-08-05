import { describe, expect, it } from 'vitest';
import { decodeNip19, normalizePubkey, npubToHex } from './nip19.js';

// NIP-19 公式テストベクタ
const OFFICIAL_NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const OFFICIAL_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

// NIP-19 公式の nprofile テストベクタ（pubkey + relay 2 件）
const OFFICIAL_NPROFILE =
  'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';
const OFFICIAL_NPROFILE_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';

// 以下は OFFICIAL_HEX を作者として組み立てた自前のベクタ
const EVENT_ID = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NPROFILE =
  'nprofile1qqs8ul5ug253hlh3n75jne0a5xmjur4urfxpzst88cnegg6ds6ka7nspzamhxue69uhhyetvv9ujuetcv9khqmr99e3k7mg3lnphh';
const NEVENT =
  'nevent1qqs9cppf9vggqpfdty7ykh6wdu72pc8qukmkukeapcxu6j7trd487ygpzamhxue69uhhyetvv9ujuetcv9khqmr99e3k7mgzypl8a8zz4ydlauvl4y57tldpkuhqa0q6fsg5zee7y72zxnvx4h05uqcyqqqqqqg4dxgkd';
/** 先頭に未知の TLV type 9 を挟んだ nevent（id + author、kind なし） */
const NEVENT_UNKNOWN_TLV =
  'nevent1pyzx5atwdvqzqhqy9y43pqq994vncj6lfehneg8qurjmwmjm858qmn2tevdk5lc3qgs8ul5ug253hlh3n75jne0a5xmjur4urfxpzst88cnegg6ds6ka7ns3ajz4u';
const NADDR =
  'naddr1qq9x67fdv9e8g6trd3jsz9mhwden5te0wfjkccte9ejhsctdwpkx2tnrdaksygr706wy92gmlmcel2ffuh76rdewp67p5nq3g9nnufu5ydxcdtwlfcpsgqqqw4rstnle8h';

describe('npubToHex', () => {
  it('should decode the NIP-19 official test vector', () => {
    expect(npubToHex(OFFICIAL_NPUB)).toBe(OFFICIAL_HEX);
  });

  it('should accept an all-uppercase npub', () => {
    expect(npubToHex(OFFICIAL_NPUB.toUpperCase())).toBe(OFFICIAL_HEX);
  });

  it('should reject a mixed-case npub', () => {
    const mixed = `npub1${OFFICIAL_NPUB.slice(5).toUpperCase()}`;
    expect(() => npubToHex(mixed)).toThrow(/mixed case/);
  });

  it('should reject a non-npub prefix', () => {
    expect(() =>
      npubToHex('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')
    ).toThrow(/npub1/);
  });

  it('should not echo an nsec (secret key) in the error message', () => {
    const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    for (const fn of [npubToHex, normalizePubkey]) {
      try {
        fn(nsec);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).not.toContain(nsec.slice(5));
      }
    }
  });

  it('should abbreviate long invalid input in the error message', () => {
    const long = `zzzz${'x'.repeat(60)}`;
    expect(() => normalizePubkey(long)).toThrow(/zzzz/);
    expect(() => normalizePubkey(long)).not.toThrow(new RegExp('x'.repeat(60)));
  });

  it('should reject a corrupted checksum', () => {
    const corrupted = OFFICIAL_NPUB.slice(0, -1) + (OFFICIAL_NPUB.endsWith('q') ? 'p' : 'q');
    expect(() => npubToHex(corrupted)).toThrow(/checksum/);
  });

  it('should reject invalid bech32 characters', () => {
    expect(() => npubToHex('npub1bio')).toThrow(/Invalid npub/);
  });
});

describe('normalizePubkey', () => {
  it('should pass through lowercase hex', () => {
    expect(normalizePubkey(OFFICIAL_HEX)).toBe(OFFICIAL_HEX);
  });

  it('should lowercase uppercase hex', () => {
    expect(normalizePubkey(OFFICIAL_HEX.toUpperCase())).toBe(OFFICIAL_HEX);
  });

  it('should decode an npub', () => {
    expect(normalizePubkey(OFFICIAL_NPUB)).toBe(OFFICIAL_HEX);
  });

  it('should reject hex of the wrong length', () => {
    expect(() => normalizePubkey(OFFICIAL_HEX.slice(0, 63))).toThrow(/Invalid pubkey/);
    expect(() => normalizePubkey(`${OFFICIAL_HEX}0`)).toThrow(/Invalid pubkey/);
  });

  it('should reject garbage input naming the input', () => {
    expect(() => normalizePubkey('hello')).toThrow(/hello/);
  });
});

describe('decodeNip19', () => {
  it('should decode an npub', () => {
    expect(decodeNip19(OFFICIAL_NPUB)).toEqual({ type: 'npub', pubkey: OFFICIAL_HEX });
  });

  it('should decode a note', () => {
    expect(decodeNip19(NOTE)).toEqual({ type: 'note', id: EVENT_ID });
  });

  it('should decode the official nprofile test vector, ignoring its relays', () => {
    expect(decodeNip19(OFFICIAL_NPROFILE)).toEqual({
      type: 'nprofile',
      pubkey: OFFICIAL_NPROFILE_HEX,
    });
  });

  it('should decode an nprofile', () => {
    expect(decodeNip19(NPROFILE)).toEqual({ type: 'nprofile', pubkey: OFFICIAL_HEX });
  });

  it('should decode an nevent with its author and kind', () => {
    expect(decodeNip19(NEVENT)).toEqual({
      type: 'nevent',
      id: EVENT_ID,
      author: OFFICIAL_HEX,
      kind: 1,
    });
  });

  it('should skip TLV types it does not understand', () => {
    expect(decodeNip19(NEVENT_UNKNOWN_TLV)).toEqual({
      type: 'nevent',
      id: EVENT_ID,
      author: OFFICIAL_HEX,
    });
  });

  it('should decode an naddr', () => {
    expect(decodeNip19(NADDR)).toEqual({
      type: 'naddr',
      kind: 30023,
      pubkey: OFFICIAL_HEX,
      identifier: 'my-article',
    });
  });

  it('should accept an all-uppercase entity', () => {
    expect(decodeNip19(NOTE.toUpperCase())).toEqual({ type: 'note', id: EVENT_ID });
  });

  it('should return null rather than throw for unusable input', () => {
    const corrupted = OFFICIAL_NPUB.slice(0, -1) + (OFFICIAL_NPUB.endsWith('q') ? 'p' : 'q');
    for (const input of [
      '',
      'hello',
      'npub1bio',
      corrupted,
      // 大文字小文字の混在
      `npub1${OFFICIAL_NPUB.slice(5).toUpperCase()}`,
      // hrp は正しいが未対応
      'nrelay1qq2k7ur9wfjhxarpwd6xj4rdrx',
      // hex はそのままでは NIP-19 ではない
      OFFICIAL_HEX,
    ]) {
      expect(decodeNip19(input)).toBeNull();
    }
  });

  it('should refuse an nsec without decoding it', () => {
    expect(
      decodeNip19('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')
    ).toBeNull();
  });

  it('should reject an entity longer than the length guard', () => {
    expect(decodeNip19(`npub1${'q'.repeat(1100)}`)).toBeNull();
  });
});
