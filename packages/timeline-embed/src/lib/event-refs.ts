/**
 * Works out whether an event points at another event — a reply (NIP-10 `e`
 * tags) or a quote (NIP-18 `q` tags).
 *
 * What this produces is a chip that reports *that* a reference exists; nothing
 * here fetches the referenced event. The body's own `nostr:` references are
 * fetched and rendered as nested cards (`note-embeds.ts`), and a `q` tag whose
 * event is already shown that way has its chip dropped by the card — but a
 * reference that exists only as a tag stays a chip, because a reply's parent is
 * context the author did not choose to quote. Showing it is still worth it:
 * without it a reply reads as a non-sequitur.
 *
 * {@link replyParentId} and {@link replyParentAddress} are the same reading of
 * NIP-10 used the other way round: `reply-tree.ts` hangs an event under the one
 * it names, rather than describing the reference to a reader.
 */

import type { NostrEvent } from '@nostr-cache/shared';

/** A 32-byte event id, lowercase hex — anything else is not addressable. */
const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * NIP-01's `kind:pubkey:d` coordinate. The identifier may be empty, so the
 * pattern stops at the separator that proves there was one.
 */
const ADDRESS_PATTERN = /^\d+:[0-9a-f]{64}:/;

export type EventRefKind = 'reply' | 'quote';

export interface EventRef {
  kind: EventRefKind;
  /** Hex id of the referenced event. */
  id: string;
}

export function isEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value);
}

/**
 * Pick the tag that names what an event is replying to.
 *
 * NIP-10 has two schemes and events in the wild use both. The marked form
 * (`["e", <id>, <relay>, "reply"|"root"|"mention"]`) is authoritative when
 * present; otherwise the deprecated positional form applies, where the last
 * such tag is the direct parent. `mention` never denotes a parent, and neither
 * does a marker this does not understand — reading one as a parent would hang a
 * reply under an event its author never answered.
 */
function findParent(
  tags: string[][],
  name: string,
  valid: (value: unknown) => boolean
): string | undefined {
  const candidates = tags.filter((tag) => tag[0] === name && valid(tag[1]));
  if (candidates.length === 0) {
    return undefined;
  }

  const byMarker = (marker: string): string | undefined =>
    candidates.filter((tag) => tag[3] === marker).at(-1)?.[1];

  // A "reply" marker names the direct parent; with only a "root" marker the
  // event is a direct reply to the thread root.
  const marked = byMarker('reply') ?? byMarker('root');
  if (marked) {
    return marked;
  }

  const unmarked = candidates.filter((tag) => tag[3] === undefined || tag[3] === '');
  return unmarked.at(-1)?.[1];
}

/**
 * The id of the event this one replies to, if any.
 *
 * Deliberately not the rule NIP-25 gives for reactions ("the last `e` tag"),
 * which `reactions.ts` implements separately: applying that one to a thread
 * would flatten every marked reply onto whatever its author happened to list
 * last, which for a NIP-10 client is usually the thread root.
 */
export function replyParentId(event: NostrEvent): string | undefined {
  return findParent(event.tags, 'e', isEventId);
}

/** The same reading for a reply to an addressable event (NIP-01 coordinate). */
export function replyParentAddress(event: NostrEvent): string | undefined {
  return findParent(event.tags, 'a', isAddress);
}

/**
 * Extract the references worth showing on a card.
 *
 * @returns Reply first (at most one), then quotes in tag order. Empty when the
 *   event stands alone.
 */
export function parseRefs(event: NostrEvent): EventRef[] {
  const refs: EventRef[] = [];
  const seen = new Set<string>([event.id]);

  const reply = replyParentId(event);
  if (reply && !seen.has(reply)) {
    seen.add(reply);
    refs.push({ kind: 'reply', id: reply });
  }

  for (const tag of event.tags) {
    if (tag[0] !== 'q' || !isEventId(tag[1]) || seen.has(tag[1])) {
      continue;
    }
    seen.add(tag[1]);
    refs.push({ kind: 'quote', id: tag[1] });
  }

  return refs;
}
