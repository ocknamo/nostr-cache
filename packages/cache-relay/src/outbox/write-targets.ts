/** 書き込みの宛先（NIP-65: 著者の write リレーと、言及した相手の read リレー）。 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { RelayList } from './relay-list.js';

/**
 * `p` が「この人への通知」を意味する kind。kind 3 や 10000 番台のリストは `p` が
 * 数百〜数千あり、全員の inbox へ配ると 1 件の書き込みが大量の接続になる。
 */
const NOTIFYING_KINDS = new Set([1, 6, 7, 16, 1111]);

/** 言及された人の上限。長いスレッドの返信は参加者全員を `p` に積む。 */
export const MAX_INBOX_RECIPIENTS = 20;
/** NIP-65 はリストを 2〜4 本に保つよう勧めているので、それを超える分は使わない。 */
export const RELAYS_PER_INBOX = 3;
/** 1 件の書き込みで開く宛先の上限。 */
export const MAX_WRITE_TARGETS = 30;

const HEX64 = /^[0-9a-f]{64}$/;

/** inbox へ届けるべき相手。著者自身は含めない。 */
export function inboxRecipients(event: NostrEvent): string[] {
  if (!NOTIFYING_KINDS.has(event.kind)) {
    return [];
  }
  const recipients = new Set<string>();
  for (const tag of event.tags) {
    if (recipients.size >= MAX_INBOX_RECIPIENTS) {
      break;
    }
    if (Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string') {
      const pubkey = tag[1].toLowerCase();
      if (HEX64.test(pubkey) && pubkey !== event.pubkey) {
        recipients.add(pubkey);
      }
    }
  }
  return [...recipients];
}

/**
 * 著者の write リレーを先に並べる。上限で切るとき、自分の投稿が自分の outbox に
 * 載らないことの方が、相手 1 人に届かないことより影響が大きい。
 */
export function writeTargets(
  event: NostrEvent,
  lists: ReadonlyMap<string, RelayList>,
  exclude: ReadonlySet<string> = new Set()
): string[] {
  const targets = new Set<string>();
  const add = (url: string) => {
    if (targets.size < MAX_WRITE_TARGETS && !exclude.has(url)) {
      targets.add(url);
    }
  };
  for (const url of lists.get(event.pubkey)?.write ?? []) {
    add(url);
  }
  for (const recipient of inboxRecipients(event)) {
    for (const url of lists.get(recipient)?.read.slice(0, RELAYS_PER_INBOX) ?? []) {
      add(url);
    }
  }
  return [...targets];
}
