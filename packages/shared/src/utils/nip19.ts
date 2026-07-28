/**
 * 最小限の NIP-19 (bech32) デコーダ
 *
 * 依存を増やさないため nostr-tools は使わず、BIP-173 の bech32（bech32m では
 * ない）デコードのみを自前実装する。対応するのは npub のみ。
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) {
        chk ^= GENERATOR[i];
      }
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const c of hrp) {
    result.push(c.charCodeAt(0) >> 5);
  }
  result.push(0);
  for (const c of hrp) {
    result.push(c.charCodeAt(0) & 0x1f);
  }
  return result;
}

/** 5bit 語列を 8bit バイト列へ変換する（パディング不許可） */
function convertWordsToBytes(words: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // 残余ビットはゼロパディングでなければならない
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) {
    return null;
  }
  return new Uint8Array(bytes);
}

/**
 * エラーメッセージ向けに入力を短縮表示する。誤って秘密鍵（nsec）等の秘匿値が
 * 渡された場合にログへ全文が流出しないよう、長い入力は先頭数文字＋長さのみ示す。
 */
function describeInput(input: string): string {
  return input.length <= 12 ? input : `${input.slice(0, 8)}... (length ${input.length})`;
}

/** 入力が nsec（秘密鍵）なら、値を一切エコーしないメッセージで即座に拒否する */
function rejectSecretKey(input: string): void {
  if (input.toLowerCase().startsWith('nsec1')) {
    throw new Error(
      'Invalid input: an nsec (secret key) was provided; expected an npub1... public key or hex. The value is not shown to avoid leaking it'
    );
  }
}

/**
 * Decode an `npub1...` string (NIP-19) into a 64-character lowercase hex
 * public key.
 *
 * @param npub The bech32-encoded public key
 * @returns The 64-character lowercase hex public key
 * @throws Error on a wrong prefix, mixed case, bad checksum, or a payload
 *   that is not exactly 32 bytes
 */
export function npubToHex(npub: string): string {
  rejectSecretKey(npub);
  if (npub !== npub.toLowerCase() && npub !== npub.toUpperCase()) {
    throw new Error(`Invalid npub (mixed case): ${describeInput(npub)}`);
  }
  const lowered = npub.toLowerCase();
  const separator = lowered.lastIndexOf('1');
  if (!lowered.startsWith('npub1') || separator !== 4) {
    throw new Error(`Invalid npub (expected npub1... prefix): ${describeInput(npub)}`);
  }
  const hrp = lowered.slice(0, separator);
  const data = lowered.slice(separator + 1);
  // データ部は 32 バイト分の語 + 6 語のチェックサム
  if (data.length < 6) {
    throw new Error(`Invalid npub (too short): ${describeInput(npub)}`);
  }
  const words: number[] = [];
  for (const c of data) {
    const value = CHARSET.indexOf(c);
    if (value === -1) {
      throw new Error(`Invalid npub (invalid character '${c}'): ${describeInput(npub)}`);
    }
    words.push(value);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) {
    throw new Error(`Invalid npub (bad checksum): ${describeInput(npub)}`);
  }
  const bytes = convertWordsToBytes(words.slice(0, -6));
  if (bytes === null || bytes.length !== 32) {
    throw new Error(
      `Invalid npub (bad padding or payload is not 32 bytes): ${describeInput(npub)}`
    );
  }
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Normalize a public key given as either 64-character hex (any case) or an
 * `npub1...` string into 64-character lowercase hex.
 *
 * @param input Hex or npub public key
 * @returns The 64-character lowercase hex public key
 * @throws Error naming the offending input (abbreviated, so secrets passed by
 *   mistake are never echoed in full) when it is neither valid hex nor a
 *   valid npub
 */
export function normalizePubkey(input: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return input.toLowerCase();
  }
  rejectSecretKey(input);
  if (input.toLowerCase().startsWith('npub1')) {
    return npubToHex(input);
  }
  throw new Error(`Invalid pubkey (expected 64-char hex or npub1...): ${describeInput(input)}`);
}
