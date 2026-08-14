/**
 * Works out which single event `<nostr-post>` is about.
 *
 * No decoding is written here: a nested quote card already resolves a NIP-19
 * reference to a filter through `decodeNip19` + `embedTarget`, and a post
 * detail is the same lookup with the reference coming from an attribute
 * instead of a note body.
 */

import { type Filter, decodeNip19 } from '@nostr-cache/shared';
import { embedKey } from './content-parts.ts';
import { toPubkeyHex } from './filter-json.ts';
import { embedTarget } from './note-embeds.ts';

const HEX_ID = /^[0-9a-f]{64}$/;

/**
 * Stricter than `Number()` on purpose: `Number('')` is `0`, so an empty `kind`
 * beside an `author` would quietly render the author's *profile* as the post.
 * `Number('0x1e')` is 30 for the same class of reason.
 */
const KIND = /^\d+$/;

/**
 * How a reaction says it is about this post: NIP-25 points at a plain event
 * with an `e` tag and at an addressable one with an `a` tag, so which of the
 * two is set decides both the reaction filter and what `reactions.ts` compares.
 */
export interface PostTargetMatch {
  id?: string;
  /** NIP-01 coordinate `kind:pubkey:d`. */
  address?: string;
}

export interface PostTarget {
  /** Same key space as {@link embedKey}, so ids and coordinates cannot collide. */
  key: string;
  filter: Filter;
  /** Answered by several versions, of which the newest wins. */
  replaceable: boolean;
  match: PostTargetMatch;
}

export interface PostTargetInput {
  /** hex id, `note1…`, `nevent1…` or `naddr1…`. */
  eventId?: string;
  /** With {@link kind} and {@link identifier}: an `naddr` spelled out. */
  author?: string;
  kind?: string;
  identifier?: string;
}

function coordinateTarget(input: PostTargetInput): PostTarget | undefined {
  const { author, kind, identifier } = input;
  if (author === undefined || author.trim() === '') {
    return undefined;
  }
  const pubkey = toPubkeyHex(author.trim());
  if (!pubkey) {
    console.warn(`[nostr-post] Invalid author (expected hex, npub or nprofile): ${author}`);
    return undefined;
  }
  const kindText = kind?.trim() ?? '';
  if (!KIND.test(kindText)) {
    console.warn(`[nostr-post] Invalid kind for an addressable post: ${kind}`);
    return undefined;
  }
  const kindNumber = Number(kindText);
  if (!Number.isSafeInteger(kindNumber)) {
    console.warn(`[nostr-post] kind is out of range: ${kind}`);
    return undefined;
  }
  // NIP-01 allows an addressable event with no identifier, so an absent
  // attribute is read as the empty one rather than rejected.
  const d = identifier ?? '';
  const key = `${kindNumber}:${pubkey}:${d}`;
  return {
    key,
    filter: { kinds: [kindNumber], authors: [pubkey], '#d': [d] },
    replaceable: true,
    match: { address: key },
  };
}

/**
 * @returns `undefined` when nothing usable was named. There is no wider query
 *   to fall back to — asking a relay for "some event" would put an arbitrary
 *   stranger's post on the embedding page.
 */
export function parsePostTarget(input: PostTargetInput): PostTarget | undefined {
  const raw = input.eventId?.trim();
  if (raw === undefined || raw === '') {
    return coordinateTarget(input);
  }

  if (HEX_ID.test(raw.toLowerCase())) {
    const id = raw.toLowerCase();
    return { key: id, filter: { ids: [id] }, replaceable: false, match: { id } };
  }

  const entity = decodeNip19(raw);
  if (!entity) {
    console.warn(`[nostr-post] Invalid event-id (expected hex, note, nevent or naddr): ${raw}`);
    return undefined;
  }
  const target = embedTarget(entity);
  if (!target) {
    // `npub` / `nprofile` decode fine but name a person. Worth its own message:
    // it is the failure a page reaches by pasting the wrong bech32 string.
    console.warn(`[nostr-post] event-id names a person rather than an event: ${raw}`);
    return undefined;
  }
  const key = embedKey(entity);
  if (key === undefined) {
    return undefined;
  }
  return {
    key,
    filter: target.filter,
    replaceable: target.replaceable,
    // `embedKey` returns NIP-01's `kind:pubkey:d` for an address, which is
    // exactly the value an `a` tag carries.
    match: entity.type === 'naddr' ? { address: key } : { id: key },
  };
}
