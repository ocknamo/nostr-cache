/**
 * Works out which single event `<nostr-post>` is about.
 *
 * A timeline is configured with a filter; a post detail is configured with one
 * event, which a page can name in four ways — a raw id, a `note1`, an `nevent1`
 * or an `naddr1` — plus the coordinate spelled out as separate attributes, for
 * a page that holds `kind` / `author` / `d` but never encoded them.
 *
 * None of the decoding is written here. `decodeNip19` already turns every one
 * of those spellings into an entity, and `embedTarget` already turns an entity
 * into the filter to ask a relay with — that is exactly what a nested quote
 * card does with a `nostr:` reference, and a post detail is the same lookup
 * with the reference coming from an attribute instead of a body.
 */

import { type Filter, decodeNip19 } from '@nostr-cache/shared';
import { embedKey } from './content-parts.ts';
import { toPubkeyHex } from './filter-json.ts';
import { embedTarget } from './note-embeds.ts';

/** A 64-character lowercase hex event id, which is what a raw `event-id` is. */
const HEX_ID = /^[0-9a-f]{64}$/;

/**
 * A `kind` attribute, spelled in decimal and nothing else.
 *
 * Stricter than `Number()` on purpose. `Number('')` is `0`, so an empty or
 * missing `kind` beside an `author` would build a filter for kind 0 — and quietly
 * render the author's *profile* as the post. `Number('0x1e')` is 30 for the same
 * class of reason.
 */
const KIND = /^\d+$/;

/**
 * How a reaction says it is about this post.
 *
 * NIP-25 points a reaction at a plain event with an `e` tag and at an
 * addressable one with an `a` tag, so which of the two is set decides what
 * `reactions.ts` compares against — and, with it, what the reaction
 * subscription filters on.
 */
export interface PostTargetMatch {
  /** Event id, for a target named by id. */
  id?: string;
  /** NIP-01 coordinate `kind:pubkey:d`, for a target named by address. */
  address?: string;
}

export interface PostTarget {
  /**
   * The target's identity: the event id, or the coordinate for an addressable
   * one. Same key space as {@link embedKey}, so the two cannot collide.
   */
  key: string;
  /** What to ask the relay for. */
  filter: Filter;
  /**
   * Answered by several versions, of which the newest wins.
   *
   * Only informational here — the view renders the first event, and the
   * timeline is already ordered newest-first — but it is what tells a caller
   * that a second event arriving is an update rather than a surprise.
   */
  replaceable: boolean;
  match: PostTargetMatch;
}

/** The attributes `<nostr-post>` collects, before any of them is understood. */
export interface PostTargetInput {
  /** hex id, `note1…`, `nevent1…` or `naddr1…`. */
  eventId?: string;
  /** With {@link kind} and {@link identifier}: an `naddr` spelled out. */
  author?: string;
  kind?: string;
  identifier?: string;
}

/** The coordinate form, used only when `event-id` was not given. */
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
  // An empty `d` is legal NIP-01 — an addressable event may have no identifier
  // — so an absent attribute is read as one rather than rejected.
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
 * Normalize whatever the element was given into one description of the post.
 *
 * @returns `undefined` when nothing usable was named — which the view renders
 *   as "no post specified" rather than falling back to a wider query. There is
 *   no sensible wider query for a detail view: asking a relay for "some event"
 *   would put an arbitrary stranger's post on the embedding page.
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
    // `npub` / `nprofile` decode fine but name a person, and a person is not a
    // post. Saying so is worth a line of its own: it is the one failure here a
    // page is likely to reach by pasting the wrong bech32 string.
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
    // `embedKey` returns the id for an event and NIP-01's `kind:pubkey:d` for
    // an address, which is exactly the value an `a` tag carries.
    match: entity.type === 'naddr' ? { address: key } : { id: key },
  };
}
