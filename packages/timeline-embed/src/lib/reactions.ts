/**
 * Reads kind 7 reactions (NIP-25) into the chips a post detail shows.
 *
 * Pure, so every rule below can be tested without booting a relay; the
 * subscription that feeds it lives in `timeline/reaction-watcher.ts`. Same split as
 * NIP-02 (`follow-list.ts`) and NIP-27 (`note-embeds.ts`).
 *
 * `content` is an arbitrary string from an arbitrary stranger and may not have
 * a verified signature yet, so it is treated as hostile input throughout — see
 * `profile.ts`.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { PostTargetMatch } from './post-target.ts';
import { safeImageUrl, safeText } from './profile.ts';

/** Cap on reactions held for one post. */
export const MAX_REACTIONS = 500;

/**
 * Distinct reactions rendered as chips. What falls off the end still counts
 * towards {@link ReactionSummary.total}.
 */
export const MAX_REACTION_GROUPS = 12;

/**
 * Reactors listed when the list is expanded.
 *
 * Each row costs a profile lookup, and those are issued four at a time — an
 * uncapped list would queue hundreds of REQs behind the visible ones.
 */
export const MAX_LISTED_REACTORS = 50;

/**
 * Longest `content` still treated as a glyph. NIP-25 content is `+`, `-`, an
 * emoji or a `:shortcode:`; grouping by anything longer would put a paragraph
 * in a chip.
 */
const MAX_REACTION_CONTENT = 32;

/** NIP-25 defines `+` and `-`, not the glyphs they are drawn as. */
const LIKE_LABEL = '⭐';
const DISLIKE_LABEL = '👎';

/** NIP-30 custom emoji reference. */
const SHORTCODE = /^:([a-zA-Z0-9_-]+):$/;

export type ReactionKind = 'like' | 'dislike' | 'emoji' | 'custom';

export interface Reaction {
  id: string;
  pubkey: string;
  createdAt: number;
  /** Kept so a press on the reactor's row can report the reaction it rode in on. */
  event: NostrEvent;
  kind: ReactionKind;
  /**
   * Deliberately the same value as {@link label}, so a reaction spelled `+` and
   * one carrying that same glyph literally share a chip rather than sitting side
   * by side looking identical.
   */
  key: string;
  label: string;
  /** NIP-30 custom emoji image, if one was published and is safe to load. */
  url?: string;
}

export interface ReactionGroup {
  key: string;
  label: string;
  url?: string;
  /** Distinct reactors — not the number of events. See {@link summarizeReactions}. */
  count: number;
}

export interface ReactionSummary {
  /** Ordered by count, capped at {@link MAX_REACTION_GROUPS}. */
  groups: ReactionGroup[];
  /**
   * Everyone the chips count, in one list rather than one per chip: any chip
   * opens all of it. Newest first, capped at {@link MAX_LISTED_REACTORS}.
   *
   * Not filtered to the chips that fit — a glyph {@link MAX_REACTION_GROUPS}
   * left out is listed here like any other, if it is recent enough to survive
   * the cap above. Someone who sent two glyphs is one row per glyph, which is
   * how {@link total} counts them and what their two rows say.
   */
  reactors: Reaction[];
  /**
   * The counts of **all** groups added up, including any the cap left out.
   *
   * Not the number of distinct people: someone who sent both a ❤️ and a 🔥
   * counts in each chip, and so counts twice here.
   */
  total: number;
  hiddenGroups: number;
}

function lastTagValue(event: NostrEvent, name: string): string | undefined {
  for (let i = event.tags.length - 1; i >= 0; i--) {
    const tag = event.tags[i];
    if (tag[0] === name && typeof tag[1] === 'string') {
      return tag[1];
    }
  }
  return undefined;
}

/**
 * Whether this reaction is about our post rather than something near it.
 *
 * A relay matches `#e` against *any* `e` tag, so a reaction to a reply — which
 * per NIP-10 carries the thread root's id too — reaches our subscription as
 * well. NIP-25 says the **last** `e` tag is the event being reacted to.
 */
function isAboutTarget(event: NostrEvent, match: PostTargetMatch): boolean {
  if (match.address !== undefined) {
    return lastTagValue(event, 'a') === match.address;
  }
  if (match.id !== undefined) {
    return lastTagValue(event, 'e') === match.id;
  }
  return false;
}

function emojiUrl(event: NostrEvent, shortcode: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'emoji' && tag[1] === shortcode) {
      return safeImageUrl(tag[2]);
    }
  }
  return undefined;
}

/**
 * @returns `undefined` for anything that is not a reaction to this post, or
 *   whose content is not something a chip can carry
 */
export function parseReaction(event: NostrEvent, match: PostTargetMatch): Reaction | undefined {
  if (event.kind !== 7 || !isAboutTarget(event, match)) {
    return undefined;
  }

  const base = { id: event.id, pubkey: event.pubkey, createdAt: event.created_at, event };

  // NIP-25: empty content means `+`. Trimmed first so whitespace-only lands
  // here rather than on the length test below.
  const raw = typeof event.content === 'string' ? event.content.trim() : '';
  if (raw === '' || raw === '+') {
    return { ...base, kind: 'like', key: LIKE_LABEL, label: LIKE_LABEL };
  }
  if (raw === '-') {
    return { ...base, kind: 'dislike', key: DISLIKE_LABEL, label: DISLIKE_LABEL };
  }

  const shortcode = SHORTCODE.exec(raw)?.[1];
  if (shortcode !== undefined) {
    // Rendered as text when no image was published: it is still the reaction
    // the author sent.
    const url = emojiUrl(event, shortcode);
    return { ...base, kind: 'custom', key: raw, label: raw, ...(url ? { url } : {}) };
  }

  const label = safeText(raw, MAX_REACTION_CONTENT);
  if (label === undefined) {
    // Too long, or nothing left after stripping control and bidi characters.
    return undefined;
  }
  return { ...base, kind: 'emoji', key: label, label };
}

/** The id breaks a tie so the result never depends on arrival order. */
function isNewer(candidate: Reaction, current: Reaction): boolean {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  );
}

interface Bucket {
  key: string;
  label: string;
  byPubkey: Map<string, Reaction>;
  /** First-seen position, so equal counts keep a stable order. */
  seq: number;
}

/**
 * A person is counted **once per chip**, keeping their newest.
 *
 * NIP-25 has no retraction and a relay holds every copy, so counting events
 * would let one person inflate a number by pressing twice. Two different emoji
 * still count once in each chip, which is what the reactor meant.
 */
export function summarizeReactions(reactions: readonly Reaction[]): ReactionSummary {
  const buckets = new Map<string, Bucket>();

  for (const reaction of reactions) {
    let bucket = buckets.get(reaction.key);
    if (!bucket) {
      bucket = {
        key: reaction.key,
        label: reaction.label,
        byPubkey: new Map(),
        seq: buckets.size,
      };
      buckets.set(reaction.key, bucket);
    }
    const current = bucket.byPubkey.get(reaction.pubkey);
    if (current === undefined || isNewer(reaction, current)) {
      bucket.byPubkey.set(reaction.pubkey, reaction);
    }
  }

  const groups: ReactionGroup[] = [...buckets.values()].map((bucket) => {
    const reactors = [...bucket.byPubkey.values()];
    // Two people can send the same shortcode with different `emoji` tags, and a
    // chip has room for one picture.
    const url = reactors.find((reactor) => reactor.url !== undefined)?.url;
    const group: ReactionGroup = {
      key: bucket.key,
      label: bucket.label,
      count: reactors.length,
    };
    if (url !== undefined) {
      group.url = url;
    }
    return group;
  });

  // Before the cap: what decides whether there is a bar at all is every
  // reaction, not the twelve glyphs that fit.
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  const order = new Map([...buckets.values()].map((bucket) => [bucket.key, bucket.seq]));
  groups.sort((a, b) => b.count - a.count || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  const reactors = [...buckets.values()]
    .flatMap((bucket) => [...bucket.byPubkey.values()])
    .sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0))
    .slice(0, MAX_LISTED_REACTORS);

  return {
    groups: groups.slice(0, MAX_REACTION_GROUPS),
    reactors,
    total,
    hiddenGroups: Math.max(0, groups.length - MAX_REACTION_GROUPS),
  };
}

/** The one call a view needs: the controller stores raw events, not a summary. */
export function summarizeReactionEvents(
  events: readonly NostrEvent[],
  match: PostTargetMatch
): ReactionSummary {
  const reactions: Reaction[] = [];
  for (const event of events) {
    const reaction = parseReaction(event, match);
    if (reaction) {
      reactions.push(reaction);
    }
  }
  return summarizeReactions(reactions);
}
