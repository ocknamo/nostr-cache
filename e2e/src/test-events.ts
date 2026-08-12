/**
 * Signed test event helpers for E2E tests.
 *
 * Events reaching the relay are verified with a real signature check
 * (@rx-nostr/crypto's verifier), so E2E events must be properly signed.
 * Mirrors packages/server/tests/utils/test-events.ts.
 */

import { type NostrEvent, getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from '@rx-nostr/crypto';

/** Create a signed Nostr event. */
export async function createTestEvent(
  seckey?: string,
  overrides: Omit<Partial<NostrEvent>, 'id' | 'pubkey' | 'sig'> = {}
): Promise<NostrEvent> {
  const hexSecKey = seckey || getRandomSecret();
  const signer = seckeySigner(hexSecKey);
  const pubkey = await signer.getPublicKey();

  const event = {
    pubkey,
    created_at: 1234567890,
    kind: 1,
    tags: [['p', pubkey]],
    content: 'test content',
    ...overrides,
  };

  return signer.signEvent(event);
}

export { getRandomSecret };

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >> bit) & 1) {
        checksum ^= BECH32_GENERATOR[bit];
      }
    }
  }
  return checksum;
}

function bech32HrpExpand(hrp: string): number[] {
  const high = [...hrp].map((char) => char.charCodeAt(0) >> 5);
  const low = [...hrp].map((char) => char.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

/**
 * Encode bytes as bech32 under the given human-readable prefix.
 *
 * The production code only ever decodes — a widget reads other people's notes,
 * it never writes one — so the encoder lives here, where a test needs to write
 * the `nostr:` reference a real client would have put in a note's body.
 */
function bech32Encode(hrp: string, bytes: number[]): string {
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((accumulator << (5 - bits)) & 31);
  }
  const checksum = bech32Polymod([...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail = Array.from({ length: 6 }, (_, index) => (checksum >> (5 * (5 - index))) & 31);
  return `${hrp}1${[...words, ...tail].map((word) => BECH32_CHARSET[word]).join('')}`;
}

function hexBytes(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16));
}

/** Encode a 32-byte hex event id as a NIP-19 `note1…`. */
export function noteBech32(idHex: string): string {
  return bech32Encode('note', hexBytes(idHex));
}

/**
 * Encode a replaceable coordinate as a NIP-19 `naddr1…`.
 *
 * TLV per NIP-19: type 0 is the `d` value as UTF-8, type 2 the author's pubkey,
 * type 3 the kind as a 4-byte big-endian integer. Relay hints (type 1) are left
 * out — the widget ignores them.
 */
export function naddrBech32(address: {
  kind: number;
  pubkey: string;
  identifier: string;
}): string {
  const identifier = [...new TextEncoder().encode(address.identifier)];
  const kind = [
    (address.kind >>> 24) & 0xff,
    (address.kind >>> 16) & 0xff,
    (address.kind >>> 8) & 0xff,
    address.kind & 0xff,
  ];
  const author = hexBytes(address.pubkey);
  return bech32Encode('naddr', [
    0,
    identifier.length,
    ...identifier,
    2,
    author.length,
    ...author,
    3,
    kind.length,
    ...kind,
  ]);
}
