/**
 * 最小限の NIP-19 (bech32) デコーダ
 *
 * 依存を増やさないため nostr-tools は使わず、BIP-173 の bech32（bech32m では
 * ない）デコードのみを自前実装する。npub の hex 変換に加えて、TLV 形式を含む
 * 表示用エンティティ（npub / nprofile / note / nevent / naddr）のデコードに
 * 対応する。
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * デコードを試みる入力長の上限。
 *
 * NIP-19 は BIP-173 の 90 文字上限を明示的に破棄している（リレー URL を複数
 * 含む nevent / naddr は容易に超える）ため長さでは弾けないが、本文中の任意の
 * 文字列を食わせる用途があるので、暴走を防ぐ緩い上限だけ設ける。
 */
const MAX_BECH32_LENGTH = 1024;

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
 * bech32 デコードが失敗した理由。エラーメッセージの括弧内にそのまま入る。
 *
 * `npubToHex` は throw、`decodeNip19` は null と、呼び出し側で失敗の扱いが
 * 正反対なので、デコーダ自体は理由を値で返して判断を委ねる。
 */
type Bech32Result = { ok: true; hrp: string; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * 汎用の bech32 デコード（BIP-173、bech32m ではない）。
 *
 * hrp は検証しない。`npub` を期待するのか `nevent` を期待するのかは呼び出し側の
 * 都合なので、ここでは区切り文字とチェックサムだけを見る。
 *
 * @param input bech32 文字列
 * @returns 成功時は hrp とデータ部のバイト列、失敗時は理由
 */
function decodeBech32(input: string): Bech32Result {
  if (input.length === 0 || input.length > MAX_BECH32_LENGTH) {
    return { ok: false, reason: 'too short' };
  }
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) {
    return { ok: false, reason: 'mixed case' };
  }
  const lowered = input.toLowerCase();
  // CHARSET に '1' は無いので、最後の '1' が必ず区切り文字になる。
  const separator = lowered.lastIndexOf('1');
  if (separator < 1) {
    return { ok: false, reason: 'too short' };
  }
  const hrp = lowered.slice(0, separator);
  const data = lowered.slice(separator + 1);
  // データ部はペイロード + 6 語のチェックサム
  if (data.length < 6) {
    return { ok: false, reason: 'too short' };
  }
  const words: number[] = [];
  for (const c of data) {
    const value = CHARSET.indexOf(c);
    if (value === -1) {
      return { ok: false, reason: `invalid character '${c}'` };
    }
    words.push(value);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) {
    return { ok: false, reason: 'bad checksum' };
  }
  const bytes = convertWordsToBytes(words.slice(0, -6));
  if (bytes === null) {
    return { ok: false, reason: 'bad padding' };
  }
  return { ok: true, hrp, bytes };
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
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
  const decoded = decodeBech32(npub);
  if (!decoded.ok) {
    throw new Error(`Invalid npub (${decoded.reason}): ${describeInput(npub)}`);
  }
  if (decoded.hrp !== 'npub') {
    throw new Error(`Invalid npub (expected npub1... prefix): ${describeInput(npub)}`);
  }
  if (decoded.bytes.length !== 32) {
    throw new Error(
      `Invalid npub (bad padding or payload is not 32 bytes): ${describeInput(npub)}`
    );
  }
  return toHex(decoded.bytes);
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

/** NIP-19 の TLV type。`relay`（1）は表示に使わないので読み飛ばす。 */
const TLV_SPECIAL = 0;
const TLV_AUTHOR = 2;
const TLV_KIND = 3;

/**
 * 表示に使う NIP-19 エンティティの prefix。
 *
 * 本文中から bech32 らしき文字列を拾う正規表現もここから組み立てられるよう、
 * 一箇所にまとめてある。秘密鍵（nsec）は意図的に含めない。
 */
export const NIP19_PREFIXES = ['npub', 'nprofile', 'note', 'nevent', 'naddr'] as const;

export type Nip19Prefix = (typeof NIP19_PREFIXES)[number];

/** 公開鍵を指すエンティティ。 */
export interface Nip19Profile {
  type: 'npub' | 'nprofile';
  /** 64 文字小文字 hex の公開鍵。 */
  pubkey: string;
}

/** 単一イベントを指すエンティティ。 */
export interface Nip19Event {
  type: 'note' | 'nevent';
  /** 64 文字小文字 hex のイベント id。 */
  id: string;
  /** 作者の公開鍵。`nevent` が author TLV を持っていたときだけ入る。 */
  author?: string;
  /** イベント kind。`nevent` が kind TLV を持っていたときだけ入る。 */
  kind?: number;
}

/** 置換可能イベントの座標（NIP-01 の `kind:pubkey:d`）を指すエンティティ。 */
export interface Nip19Address {
  type: 'naddr';
  kind: number;
  pubkey: string;
  /** `d` タグの値。空文字もありうる。 */
  identifier: string;
}

export type Nip19Entity = Nip19Profile | Nip19Event | Nip19Address;

/**
 * TLV ストリームを type ごとに読み出す。
 *
 * 同じ type が複数回現れる（relay がその典型）ので値は配列で持つ。長さが足り
 * ない打ち切られたストリームは、部分的に読めても信用できないので拒否する。
 *
 * @returns type をキーにした値の配列、壊れていれば null
 */
function parseTlv(bytes: Uint8Array): Map<number, Uint8Array[]> | null {
  const entries = new Map<number, Uint8Array[]>();
  let offset = 0;
  while (offset < bytes.length) {
    // type と length の 2 バイトすら残っていない
    if (offset + 2 > bytes.length) {
      return null;
    }
    const type = bytes[offset];
    const length = bytes[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (end > bytes.length) {
      return null;
    }
    const values = entries.get(type);
    if (values) {
      values.push(bytes.subarray(start, end));
    } else {
      entries.set(type, [bytes.subarray(start, end)]);
    }
    offset = end;
  }
  return entries;
}

/** TLV の値を 32 バイトの hex として読む。長さが違えば undefined。 */
function readHex32(value: Uint8Array | undefined): string | undefined {
  return value !== undefined && value.length === 32 ? toHex(value) : undefined;
}

/** TLV の kind を読む。NIP-19 は 4 バイトのビッグエンディアンと定めている。 */
function readKind(value: Uint8Array | undefined): number | undefined {
  if (value === undefined || value.length !== 4) {
    return undefined;
  }
  // `>>> 0` で符号付き 32bit 化を打ち消す。kind は非負。
  return ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0;
}

/**
 * NIP-19 エンティティをデコードする。
 *
 * `npubToHex` と違い **throw しない**。本文中から拾った bech32 らしき文字列を
 * 片端から試す用途があり、そこでは失敗が例外ではなく常態だからである。
 *
 * `nsec`（秘密鍵）は誤って表示に載せないよう、デコードを試みずに拒否する。
 *
 * @param input `nostr:` を除いた bech32 文字列
 * @returns デコード結果、または解釈できなければ null
 */
export function decodeNip19(input: string): Nip19Entity | null {
  if (input.toLowerCase().startsWith('nsec1')) {
    return null;
  }
  const decoded = decodeBech32(input);
  if (!decoded.ok) {
    return null;
  }
  const { hrp, bytes } = decoded;

  if (hrp === 'npub') {
    return bytes.length === 32 ? { type: 'npub', pubkey: toHex(bytes) } : null;
  }
  if (hrp === 'note') {
    return bytes.length === 32 ? { type: 'note', id: toHex(bytes) } : null;
  }
  if (hrp !== 'nprofile' && hrp !== 'nevent' && hrp !== 'naddr') {
    return null;
  }

  const tlv = parseTlv(bytes);
  if (!tlv) {
    return null;
  }
  const special = tlv.get(TLV_SPECIAL)?.[0];
  const author = readHex32(tlv.get(TLV_AUTHOR)?.[0]);
  const kind = readKind(tlv.get(TLV_KIND)?.[0]);

  if (hrp === 'nprofile') {
    const pubkey = readHex32(special);
    return pubkey ? { type: 'nprofile', pubkey } : null;
  }
  if (hrp === 'nevent') {
    const id = readHex32(special);
    if (!id) {
      return null;
    }
    const event: Nip19Event = { type: 'nevent', id };
    if (author) {
      event.author = author;
    }
    if (kind !== undefined) {
      event.kind = kind;
    }
    return event;
  }

  // naddr。座標は三つ揃って初めて意味を持つので、どれか欠けたら諦める。
  // identifier は `d` タグの値そのままで、空文字も正当。
  if (special === undefined || author === undefined || kind === undefined) {
    return null;
  }
  return {
    type: 'naddr',
    kind,
    pubkey: author,
    identifier: new TextDecoder().decode(special),
  };
}
