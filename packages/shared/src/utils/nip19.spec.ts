import { describe, expect, it } from 'vitest';
import { normalizePubkey, npubToHex } from './nip19.js';

// NIP-19 公式テストベクタ
const OFFICIAL_NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const OFFICIAL_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

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
