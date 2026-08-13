/**
 * Decides which `nostr:` references in a body are rendered as nested cards, and
 * what to ask the relay for. NIP-27 allows a reader client to render such a
 * reference as a preview, which is what a card is here.
 *
 * There is deliberately **no cycle guard**. An event id is the hash of the
 * signed event, so quoting an event requires it to already exist — a pair of
 * events quoting each other cannot be constructed. (An `naddr` names a
 * coordinate rather than a hash, so a loop is constructible there; the depth cap
 * is what ends it, at the cost of at most five lookups.)
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import {
  type ContentPart,
  type EntityPart,
  type MediaPart,
  embedKey,
  mediaParts,
} from './content-parts.ts';

/** Timeline cards are depth 0, so this is how many nested cards a chain shows. */
export const MAX_EMBED_DEPTH = 5;

/**
 * The cap below depth 0, where it is the base of an exponent: two per note over
 * the remaining four levels is at most 2+4+8+16 = 30 lookups under a single
 * quote, and the relay caps a client at 20 concurrent subscriptions. References
 * past the cap stay chips.
 */
export const MAX_EMBEDS_PER_NOTE = 2;

/**
 * Higher than {@link MAX_EMBEDS_PER_NOTE} because a timeline card is the note
 * the reader actually asked for, and its references are the ones worth showing
 * in full. Raising *this* one is affordable because it is a multiplier rather
 * than the base of the exponent — the levels under it stay on the smaller cap,
 * so a card's whole tree is at most 10+20+40+80+160 = 310 lookups (it was 62
 * when both caps were two). Those are one-shot REQs, issued two at a time as
 * cards scroll into view, not concurrent subscriptions.
 */
export const MAX_EMBEDS_PER_TOP_NOTE = 10;

export type EmbedStatus = 'loading' | 'ready' | 'missing';

/**
 * `missing` covers "not published", "not upstream" and "the relay never
 * answered" alike — none of them is distinguishable from here, and all three
 * come out as the same chip.
 */
export interface EmbeddedEvent {
  status: EmbedStatus;
  event?: NostrEvent;
}

export interface EmbedTarget {
  /** {@link embedKey} of the entity. */
  key: string;
  filter: Filter;
  /** Answered by several versions, of which the newest wins. */
  replaceable: boolean;
}

/**
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
 * @param depth Depth of the card doing the rendering — 0 for a timeline card,
 *   which is capped at {@link MAX_EMBEDS_PER_TOP_NOTE} rather than
 *   {@link MAX_EMBEDS_PER_NOTE}
 * @returns Empty once {@link MAX_EMBED_DEPTH} is reached, which is what leaves
 *   the deepest level's references in the text as chips
 */
export function selectEmbeds(parts: ContentPart[], depth: number): EntityPart[] {
  if (depth >= MAX_EMBED_DEPTH) {
    return [];
  }
  const max = depth === 0 ? MAX_EMBEDS_PER_TOP_NOTE : MAX_EMBEDS_PER_NOTE;
  const selected: EntityPart[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (selected.length >= max) {
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

/** The `embedded` set `inlineParts` lifts the text by. */
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

export type NoteSegment =
  | { kind: 'text'; parts: ContentPart[] }
  | { kind: 'embed'; part: EntityPart };

/**
 * Whether a run renders nothing at all, and so is not worth a segment.
 *
 * Two things are invisible: whitespace, which `normalize` would trim away
 * anyway, and a repeat reference to an event already placed as a card, which
 * `NoteContent` lifts out by key. A run of only those would be an element-less
 * segment sitting between two cards — harmless to look at, but it would break
 * the "every `text` segment renders something" property the margin collapsing
 * around `.embed` is reasoned about with.
 */
function isBlank(run: ContentPart[], embedded: ReadonlySet<string>): boolean {
  return run.every((part) => {
    if (part.kind === 'text') {
      return part.text.trim().length === 0;
    }
    if (part.kind !== 'entity') {
      return false;
    }
    const key = embedKey(part.entity);
    return key !== undefined && embedded.has(key);
  });
}

/**
 * Split a note's parts into the order a reader actually sees: a run of text,
 * then a card, then the next run of text, and so on — instead of every card
 * collapsed to the bottom of the note. Media stays inside the `text` runs, so
 * it renders wherever `NoteContent` lifts it out — the tail of whichever run
 * it fell in. See {@link segmentMedia} for keeping that dedup working across
 * the runs this produces.
 *
 * @param embedded Keys ({@link embedKey}) of the entities to place as cards,
 *   i.e. `embedKeys(selectEmbeds(parts, depth))`
 * @returns Segments in source order, and every `text` one renders something
 *   (see {@link isBlank}) — two references back to back produce two adjacent
 *   `embed` segments, not an empty `text` one between them. A second
 *   reference to an event already placed as a card stays in its `text` run,
 *   for `NoteContent`'s own lift (by key) to remove — the same "one quote,
 *   one card" rule `selectEmbeds` already enforces, applied to rendering: the
 *   repeat mention disappears rather than becoming a second card or a chip.
 */
export function noteSegments(parts: ContentPart[], embedded: ReadonlySet<string>): NoteSegment[] {
  const segments: NoteSegment[] = [];
  const placed = new Set<string>();
  let run: ContentPart[] = [];

  /** Close the run that has been collected, if a reader would see any of it. */
  const flush = () => {
    if (run.length > 0 && !isBlank(run, embedded)) {
      segments.push({ kind: 'text', parts: run });
    }
    run = [];
  };

  for (const part of parts) {
    if (part.kind === 'entity') {
      const key = embedKey(part.entity);
      if (key !== undefined && embedded.has(key) && !placed.has(key)) {
        placed.add(key);
        flush();
        segments.push({ kind: 'embed', part });
        continue;
      }
    }
    run.push(part);
  }

  flush();
  return segments;
}

/**
 * The `{#each}` key for a segment.
 *
 * Derived from the segment's own content rather than its position: the list
 * grows from a single run to several as embeds resolve, and a bare index would
 * let a nested card inherit the request state of whichever card previously sat
 * at that index. An `embedKey` cannot collide with the `text-` prefix — it is
 * either 64 hex characters or NIP-01's `kind:pubkey:d`.
 */
export function segmentKey(segment: NoteSegment, index: number): string {
  if (segment.kind !== 'embed') {
    return `text-${index}`;
  }
  return embedKey(segment.part.entity) ?? `embed-${index}`;
}

/**
 * {@link mediaParts} for every `text` segment {@link noteSegments} produced,
 * with the dedup by URL carried across them: `mediaParts` alone dedups only
 * within the run it is given, so a photo linked once above a quote and again
 * below it would otherwise render — and be fetched — twice.
 *
 * @returns One list per segment, in the same order, empty for an `embed` one.
 *   A URL belongs to the first segment it was written in.
 */
export function segmentMedia(segments: NoteSegment[]): MediaPart[][] {
  const seen = new Set<string>();
  return segments.map((segment) => {
    if (segment.kind !== 'text') {
      return [];
    }
    return mediaParts(segment.parts).filter((part) => {
      if (seen.has(part.url)) {
        return false;
      }
      seen.add(part.url);
      return true;
    });
  });
}
