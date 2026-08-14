/**
 * Reads kind 7 reactions (NIP-25) into the chips and reactor rows a post detail
 * shows.
 *
 * Pure functions only: no DOM, no relay connection. The subscription that
 * feeds them lives in `timeline-controller.ts`, exactly as NIP-02 parsing lives
 * in `follow-list.ts` and NIP-27 selection in `note-embeds.ts` while the
 * controller stays plumbing. That split is what lets every rule below be tested
 * without booting a relay.
 *
 * Everything here treats the event as hostile input, for the same reason
 * `profile.ts` does: a reaction's `content` is an arbitrary string from an
 * arbitrary stranger, it may not have a verified signature yet when it first
 * reaches the UI, and it is rendered inline in a chip next to other people's.
 *
 * Nothing here writes: publishing a reaction needs a key, and the widget has
 * none — see `event-actions.ts`. A page that wants a working like button
 * declares one in `actions` and acts on the DOM event itself.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { PostTargetMatch } from './post-target.ts';
import { safeImageUrl, safeText } from './profile.ts';

/**
 * Cap on reactions held for one post.
 *
 * Reached only by a post with a genuinely large audience, and what it protects
 * is the render: every reaction above this changes a count the reader is not
 * reading digit by digit anyway.
 */
export const MAX_REACTIONS = 500;

/**
 * Distinct reactions rendered as chips.
 *
 * The bar is meant to be scanned, and a post that attracted forty different
 * emoji says the same thing at twelve. What falls off the end still counts
 * towards {@link ReactionSummary.total}, so nothing is silently lost.
 */
export const MAX_REACTION_GROUPS = 12;

/**
 * Reactors listed when a chip is expanded.
 *
 * Each row costs an avatar image and, before that, a profile lookup — and those
 * are issued four at a time (see `timeline-controller.ts`), so an uncapped list
 * under a popular post would queue hundreds of REQs behind the ones the reader
 * can see.
 */
export const MAX_REACTORS_PER_GROUP = 50;

/**
 * Longest `content` still treated as a reaction glyph.
 *
 * NIP-25 content is `+`, `-`, an emoji or a `:shortcode:`. Anything longer is
 * not a glyph, and grouping by it would put a paragraph in a chip.
 */
const MAX_REACTION_CONTENT = 32;

/** What `+` and `-` are rendered as; NIP-25 defines them, not their glyphs. */
const LIKE_LABEL = '❤️';
const DISLIKE_LABEL = '👎';

/** `:shortcode:`, the NIP-30 spelling of a custom emoji in `content`. */
const SHORTCODE = /^:([a-zA-Z0-9_-]+):$/;

export type ReactionKind = 'like' | 'dislike' | 'emoji' | 'custom';

export interface Reaction {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: ReactionKind;
  /**
   * What groups this reaction with the others like it.
   *
   * Deliberately the same value as {@link label}: NIP-25's `+` and a literal
   * `❤️` mean the same thing to a reader, and giving them separate keys would
   * put two identical-looking chips side by side.
   */
  key: string;
  /** The glyph (or `:shortcode:`) to render. */
  label: string;
  /** NIP-30 custom emoji image, when one was published and is safe to load. */
  url?: string;
}

export interface ReactionGroup {
  key: string;
  label: string;
  url?: string;
  /** Distinct reactors, which is not the number of events — see below. */
  count: number;
  /** Newest first, capped at {@link MAX_REACTORS_PER_GROUP}. */
  reactors: Reaction[];
}

export interface ReactionSummary {
  /** Ordered by count, capped at {@link MAX_REACTION_GROUPS}. */
  groups: ReactionGroup[];
  /** Distinct reactors across **all** groups, including any not rendered. */
  total: number;
  /** Groups dropped by the cap, so the view can say there are more. */
  hiddenGroups: number;
}

/** The value of the last tag with this name, which is what NIP-25 points with. */
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
 * carries the reply's id and, per NIP-10, the thread root's too — is delivered
 * by our subscription as well. NIP-25 says the **last** `e` tag is the event
 * being reacted to, so that is what decides, and the reactions counted are the
 * ones the reader would agree are on this post.
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

/** The NIP-30 `["emoji", shortcode, url]` entry for a shortcode, if published. */
function emojiUrl(event: NostrEvent, shortcode: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'emoji' && tag[1] === shortcode) {
      return safeImageUrl(tag[2]);
    }
  }
  return undefined;
}

/**
 * Read one kind 7 event.
 *
 * @returns `undefined` for anything that is not a reaction to this post, or
 *   whose content is not something a chip can carry
 */
export function parseReaction(event: NostrEvent, match: PostTargetMatch): Reaction | undefined {
  if (event.kind !== 7 || !isAboutTarget(event, match)) {
    return undefined;
  }

  const base = { id: event.id, pubkey: event.pubkey, createdAt: event.created_at };

  // NIP-25: an empty content means the same as `+`. Checked before sanitizing
  // so a content of only whitespace lands here too rather than on the length
  // test below.
  const raw = typeof event.content === 'string' ? event.content.trim() : '';
  if (raw === '' || raw === '+') {
    return { ...base, kind: 'like', key: LIKE_LABEL, label: LIKE_LABEL };
  }
  if (raw === '-') {
    return { ...base, kind: 'dislike', key: DISLIKE_LABEL, label: DISLIKE_LABEL };
  }

  const shortcode = SHORTCODE.exec(raw)?.[1];
  if (shortcode !== undefined) {
    const url = emojiUrl(event, shortcode);
    // Without a usable image the shortcode is still the reaction the author
    // sent, so it is rendered as the text it is rather than dropped.
    return { ...base, kind: 'custom', key: raw, label: raw, ...(url ? { url } : {}) };
  }

  const label = safeText(raw, MAX_REACTION_CONTENT);
  if (label === undefined) {
    // Too long, or nothing left once the control and bidi characters were
    // stripped. Either way there is no glyph to put in a chip.
    return undefined;
  }
  return { ...base, kind: 'emoji', key: label, label };
}

/** Newest wins; the id breaks a tie so the result never depends on arrival order. */
function isNewer(candidate: Reaction, current: Reaction): boolean {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  );
}

interface Bucket {
  key: string;
  label: string;
  /** One entry per reactor: the same person's repeats collapse onto their newest. */
  byPubkey: Map<string, Reaction>;
  /** First-seen position, so equal counts keep a stable order. */
  seq: number;
}

/**
 * Group reactions into the chips a post detail renders.
 *
 * A person is counted **once per chip**, keeping their newest reaction of that
 * kind. NIP-25 has no retraction and a relay holds every copy, so counting
 * events would let one person inflate a number by pressing twice. Reacting with
 * two different emoji still counts once in each — which is what other clients
 * show, and what the reactor meant.
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
    const reactors = [...bucket.byPubkey.values()].sort((a, b) =>
      isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0
    );
    // The newest reactor who published an image decides the chip's: two people
    // can send the same shortcode with different `emoji` tags, and a chip has
    // room for one picture.
    const url = reactors.find((reactor) => reactor.url !== undefined)?.url;
    const group: ReactionGroup = {
      key: bucket.key,
      label: bucket.label,
      count: reactors.length,
      reactors: reactors.slice(0, MAX_REACTORS_PER_GROUP),
    };
    if (url !== undefined) {
      group.url = url;
    }
    return group;
  });

  // Counted before the cap: a reader who sees "42" and eleven chips has been
  // told the truth about the post, which a total of only the rendered chips
  // would not be.
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  const order = new Map([...buckets.values()].map((bucket) => [bucket.key, bucket.seq]));
  groups.sort((a, b) => b.count - a.count || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  return {
    groups: groups.slice(0, MAX_REACTION_GROUPS),
    total,
    hiddenGroups: Math.max(0, groups.length - MAX_REACTION_GROUPS),
  };
}

/**
 * Read a post's raw kind 7 events into a summary.
 *
 * The controller stores the events rather than a summary — the same way it
 * stores notes and lets the card derive its segments — so this is the one call
 * a view needs.
 */
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
