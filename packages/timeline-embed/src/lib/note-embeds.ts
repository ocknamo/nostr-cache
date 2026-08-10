/**
 * Decides which `nostr:` references in a body are rendered as nested cards, and
 * what to ask the relay for.
 *
 * NIP-27 makes the `nostr:` code in `.content` the way a note quotes another
 * note, and lets a reader client render it as a preview rather than as a link.
 * That preview is what a card is here: the referenced event is fetched and drawn
 * inside the quoting one.
 *
 * Two caps, and no third mechanism:
 * - {@link MAX_EMBED_DEPTH} stops the recursion. A quote of a quote of a quote
 *   is still worth reading; five levels down, the reference is what matters and
 *   the chip says it.
 * - {@link MAX_EMBEDS_PER_NOTE} bounds the fan-out. Depth alone does not: with
 *   no per-note cap a note listing twenty references would open twenty lookups,
 *   each of which may open twenty more.
 *
 * There is deliberately **no cycle guard**. An event id is the hash of the
 * signed event, so quoting an event requires it to already exist — a pair of
 * events quoting each other cannot be constructed. (An `naddr` names a
 * coordinate rather than a hash, so a loop is constructible there; the depth cap
 * is what ends it, at the cost of at most five lookups.)
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { type ContentPart, type EntityPart, embedKey } from './content-parts.ts';

/**
 * How deep the nesting goes. The card of a timeline event is depth 0, so this
 * is the number of nested cards a chain can show; past it a reference stays the
 * abbreviated chip it has always been.
 */
export const MAX_EMBED_DEPTH = 5;

/**
 * Nested cards rendered for one body.
 *
 * Two, not more, because the depth multiplies it: two per note over five levels
 * is at most 2+4+8+16+32 = 62 lookups for one timeline card, and the relay caps
 * a client at 20 concurrent subscriptions. References past the cap stay chips.
 */
export const MAX_EMBEDS_PER_NOTE = 2;

/** Progress of one nested card's lookup. */
export type EmbedStatus = 'loading' | 'ready' | 'missing';

/**
 * What is known about a referenced event.
 *
 * `missing` covers "not published", "not upstream" and "the relay never
 * answered" alike — none of them is distinguishable from here, and all three
 * come out as the same chip.
 */
export interface EmbeddedEvent {
  status: EmbedStatus;
  /** Set only once `status` is `ready`. */
  event?: NostrEvent;
}

/** One lookup: the key it is filed under, and the REQ that answers it. */
export interface EmbedTarget {
  /** {@link embedKey} of the entity. */
  key: string;
  filter: Filter;
  /**
   * Whether the filter names a replaceable coordinate rather than an id, and so
   * can be answered by several versions of which the newest wins.
   */
  replaceable: boolean;
}

/**
 * The lookup for one entity.
 *
 * @returns undefined for an entity that names a person (`npub`, `nprofile`)
 *   rather than an event — those stay `@name` mentions in the text
 */
export function embedTarget(entity: EntityPart['entity']): EmbedTarget | undefined {
  const key = embedKey(entity);
  if (key === undefined) {
    return undefined;
  }
  if (entity.type === 'naddr') {
    return {
      key,
      filter: { kinds: [entity.kind], authors: [entity.pubkey], '#d': [entity.identifier] },
      replaceable: true,
    };
  }
  // Deliberately the id alone, even when an `nevent` carried a kind TLV: the
  // TLV is a hint written by whoever encoded the entity, and a wrong one would
  // turn a fetchable event into a permanent "missing".
  return { key, filter: { ids: [key] }, replaceable: false };
}

/**
 * The references to render as nested cards, in the order they appear.
 *
 * @param depth Depth of the card doing the rendering — 0 for a timeline card
 * @returns At most {@link MAX_EMBEDS_PER_NOTE} entities, one per distinct
 *   target. Empty once {@link MAX_EMBED_DEPTH} is reached, which is what leaves
 *   the deepest level's references in the text as chips.
 */
export function selectEmbeds(parts: ContentPart[], depth: number): EntityPart[] {
  if (depth >= MAX_EMBED_DEPTH) {
    return [];
  }
  const selected: EntityPart[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (selected.length >= MAX_EMBEDS_PER_NOTE) {
      break;
    }
    if (part.kind !== 'entity') {
      continue;
    }
    const key = embedKey(part.entity);
    if (key === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(part);
  }
  return selected;
}

/** The keys of the given entities, for the `embedded` set the text is lifted by. */
export function embedKeys(parts: EntityPart[]): Set<string> {
  const keys = new Set<string>();
  for (const part of parts) {
    const key = embedKey(part.entity);
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
}
