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
 */

import type { NostrEvent } from '@nostr-cache/shared';

/** A 32-byte event id, lowercase hex — anything else is not addressable. */
const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;

export type EventRefKind = 'reply' | 'quote';

export interface EventRef {
  kind: EventRefKind;
  /** Hex id of the referenced event. */
  id: string;
}

function isEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
}

/**
 * Pick the `e` tag that names the event being replied to.
 *
 * NIP-10 has two schemes and events in the wild use both. The marked form
 * (`["e", <id>, <relay>, "reply"|"root"|"mention"]`) is authoritative when
 * present; otherwise the deprecated positional form applies, where the last
 * `e` tag is the direct parent. `mention` never denotes a parent.
 */
function findReplyTarget(tags: string[][]): string | undefined {
  const eTags = tags.filter((tag) => tag[0] === 'e' && isEventId(tag[1]));
  if (eTags.length === 0) {
    return undefined;
  }

  const byMarker = (marker: string): string | undefined =>
    eTags.filter((tag) => tag[3] === marker).at(-1)?.[1];

  // A "reply" marker names the direct parent; with only a "root" marker the
  // event is a direct reply to the thread root.
  const marked = byMarker('reply') ?? byMarker('root');
  if (marked) {
    return marked;
  }

  // Positional form. Tags explicitly marked as mentions are not parents, and
  // neither are markers we do not understand.
  const unmarked = eTags.filter((tag) => tag[3] === undefined || tag[3] === '');
  return unmarked.at(-1)?.[1];
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

  const reply = findReplyTarget(event.tags);
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
