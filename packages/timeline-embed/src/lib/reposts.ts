/**
 * Reads reposts (NIP-18): which events are one, and which event they carry.
 *
 * Pure, like `reactions.ts` and `event-refs.ts`. Deliberately says nothing
 * about `content`: a repost carries a copy of the reposted event there, and it
 * arrives with no verdict from the relay — anyone can put anyone's name on one.
 * The card fetches the event by id instead, like any other nested quote.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { isEventId } from './event-refs.ts';

/** 6 reposts a kind 1; 16 is the generic form, for everything else. */
const REPOST_KINDS = new Set([6, 16]);

export function isRepost(event: NostrEvent): boolean {
  return REPOST_KINDS.has(event.kind);
}

/**
 * The id of the reposted event.
 *
 * The **last** `e` tag, as NIP-25 reads a reaction's: a repost is about one
 * event, and a client that wrote more than one tag put the subject last.
 *
 * @returns `undefined` when no `e` tag carries an event id — a kind 16 of an
 *   addressable event names it in an `a` tag instead
 */
export function repostTargetId(event: NostrEvent): string | undefined {
  for (let i = event.tags.length - 1; i >= 0; i--) {
    const tag = event.tags[i];
    if (tag[0] === 'e' && isEventId(tag[1])) {
      return tag[1];
    }
  }
  return undefined;
}
