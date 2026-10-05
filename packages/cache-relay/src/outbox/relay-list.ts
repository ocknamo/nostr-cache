/** NIP-65（kind 10002）のリレーリストの解釈。 */

import type { NostrEvent } from '@nostr-cache/shared';
import { RELAY_LIST_KIND } from '../event/event-kind.js';

export interface RelayList {
  /** その人宛てのイベント（言及・返信）を読むリレー。 */
  read: string[];
  /** その人が書くリレー。 */
  write: string[];
}

/** 数百件を並べたリストも実在する。そのまま宛先にすると 1 人で接続数を食い潰す。 */
export const MAX_LIST_RELAYS = 20;

const NON_PUBLIC_SUFFIXES = [
  '.onion',
  '.local',
  '.localhost',
  '.invalid',
  '.test',
  '.example',
  '.internal',
  '.lan',
  '.home.arpa',
];

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * 署名さえあれば誰でも書けるリストから接続先を選ぶので、閲覧者の手元のネットワークや
 * 到達できない名前を指す URL は宛先にしない。IPv6 リテラルは公開リレーでの使用例が
 * 無いに等しく、範囲判定を持つ価値が無いので一律に外す。
 */
function isPublicHost(hostname: string): boolean {
  if (hostname === 'localhost' || !hostname.includes('.')) {
    return false;
  }
  if (hostname.startsWith('[')) {
    return false;
  }
  if (NON_PUBLIC_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return !isPrivateIpv4(hostname);
  }
  return true;
}

/**
 * 宛先として使えるリレー URL に正規化する。使えなければ undefined。
 * `wss:` に限るのは、平文の `ws:` を他人のリストを根拠に開かないため。
 */
export function normalizeRelayUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'wss:' || url.username || url.password) {
    return undefined;
  }
  // WHATWG URL は 10 進以外の IPv4 表記もドット区切りに直すので、判定はこの後でよい
  if (!isPublicHost(url.hostname)) {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `wss://${url.host}${path}${url.search}`;
}

/**
 * kind 10002 の `r` タグを read / write に振り分ける。マーカー無しは両方に入れ、
 * 未知のマーカーのタグは捨てる。
 */
export function parseRelayList(event: NostrEvent): RelayList {
  const read = new Set<string>();
  const write = new Set<string>();
  if (event.kind !== RELAY_LIST_KIND) {
    return { read: [], write: [] };
  }
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'r' || typeof tag[1] !== 'string') {
      continue;
    }
    // 空文字のマーカーを書くクライアントがある
    const marker = tag[2] === '' ? undefined : tag[2];
    if (marker !== undefined && marker !== 'read' && marker !== 'write') {
      continue;
    }
    const url = normalizeRelayUrl(tag[1]);
    if (!url) {
      continue;
    }
    if (marker !== 'write' && read.size < MAX_LIST_RELAYS) {
      read.add(url);
    }
    if (marker !== 'read' && write.size < MAX_LIST_RELAYS) {
      write.add(url);
    }
  }
  return { read: [...read], write: [...write] };
}
