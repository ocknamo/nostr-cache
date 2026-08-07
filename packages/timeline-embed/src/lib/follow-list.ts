/**
 * NIP-02 (kind 3, follow list) knowledge, kept in one place.
 *
 * `<nostr-follow-timeline>` is the widget's first two-stage subscription: the
 * authors of its timeline REQ are not known until a relay has answered with the
 * subject's follow list. This module owns the interpretation of that event —
 * and nothing else. {@link parseFollowList} and {@link selectAuthors} are pure
 * functions over an event, so the NIP-02 rules can be tested without a DOM or a
 * relay; {@link followFilterSource} is the thin adapter that turns them into the
 * `FilterSource` the controller calls between connecting and subscribing.
 *
 * See `doc/plan/follow-timeline.md` §4 for why the controller is deliberately
 * left ignorant of all of this.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { FilterSource } from './timeline-controller.ts';

import { fetchLatestReplaceable } from './one-shot-request.ts';

/**
 * Follow-list entries put on the timeline REQ unless `max-follows` says fewer.
 *
 * A safety valve, not a tuning knob. Measurements against two real relays
 * (`doc/plan/follow-timeline.md` §7.2) showed both answering a 982-author
 * filter without complaint and only ~10ms slower than a 500-author one, so a
 * cap low enough to bite would silently drop a large share of someone's follows
 * — which does not make the timeline faster in any way a reader would notice,
 * it makes it the *wrong* timeline. The remaining reasons to cap at all are the
 * client-side ones (Dexie materializing every matching row before applying
 * `limit`, and serialized ingest), and those are still unmeasured, so the
 * default is set well above any real follow list and left there until they are.
 */
export const DEFAULT_MAX_FOLLOWS = 2000;

/** Lowercase 64-character hex, the wire form of a pubkey. */
const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Extract the followed pubkeys from a kind 3 event.
 *
 * NIP-02 puts each follow in a `p` tag whose second element is a hex pubkey;
 * the third and fourth (relay hint, petname) are ignored — see
 * `doc/plan/follow-timeline.md` §10 for why the relay hints go unused.
 *
 * Defensive throughout, because this is upstream-supplied data that decides the
 * whole timeline: a tag that is not `["p", <hex>]` is skipped rather than
 * taking the list down with it, and duplicates are collapsed so the REQ does
 * not carry the same author twice.
 *
 * @param event The subject's kind 3 event
 * @returns Lowercase hex pubkeys, in the order the event lists them
 */
export function parseFollowList(event: NostrEvent): string[] {
  if (event.kind !== 3) {
    return [];
  }
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'p' || typeof tag[1] !== 'string') {
      continue;
    }
    if (!HEX64.test(tag[1])) {
      continue;
    }
    seen.add(tag[1].toLowerCase());
  }
  return [...seen];
}

export interface SelectAuthorsOptions {
  /** The subject, so their own posts can be included. */
  pubkey: string;
  /** Cap on follow-list entries. The subject is counted separately. */
  maxFollows: number;
  /** Whether the subject's own posts belong in the timeline. */
  includeSelf: boolean;
}

export interface SelectedAuthors {
  /** Pubkeys for the timeline filter's `authors`. */
  authors: string[];
  /** Follow-list entries dropped by `maxFollows`. */
  truncated: number;
}

/**
 * Turn a follow list into the `authors` of a timeline filter.
 *
 * Truncation takes the *first* `maxFollows` entries. NIP-02 suggests appending
 * new follows at the end, which would make the tail the interesting part, but
 * no client is obliged to honour that and several do not — so no meaning is
 * assumed for the order either way. With the default cap set above any real
 * follow list (see {@link DEFAULT_MAX_FOLLOWS}) this branch should almost never
 * be reached in practice.
 *
 * The subject is added *after* truncation and does not count against the cap:
 * `max-follows` reads as "how many people I follow", and having `include-self`
 * silently evict a follow would be a surprising way for the two to interact.
 */
export function selectAuthors(follows: string[], options: SelectAuthorsOptions): SelectedAuthors {
  const kept = follows.slice(0, Math.max(0, options.maxFollows));
  const truncated = follows.length - kept.length;
  const authors = new Set(kept);
  if (options.includeSelf) {
    // A subject who follows themselves is common enough that the set matters:
    // a duplicated author in a REQ is legal but pointless.
    authors.add(options.pubkey);
  }
  return { authors: [...authors], truncated };
}

export interface FollowFilterSourceOptions {
  /** Hex pubkey whose follow list drives the timeline. */
  pubkey: string;
  /** Event kinds for the timeline REQ. */
  kinds: number[];
  /** Events to request. */
  limit: number;
  /** Cap on follow-list entries; see {@link DEFAULT_MAX_FOLLOWS}. */
  maxFollows: number;
  /** Whether to add the subject's own posts. */
  includeSelf: boolean;
  /**
   * When set, bound the timeline filter to the last N seconds.
   *
   * Off unless asked for. A `since` narrows the local query to a `created_at`
   * range instead of materializing every cached row by the followed authors
   * (`doc/plan/follow-timeline.md` §7), but it trades completeness for that: a
   * quiet follow list produces an empty timeline, and the reader cannot tell
   * "nobody posted" from "the window cut it off". It goes on the kind 1 filter
   * only — a `since` makes a filter ineligible for the freshness window (§8),
   * which is the one thing the kind 3 fetch depends on.
   */
  sinceSeconds?: number;
  /** Wall clock, injectable so the `since` a spec sees is deterministic. */
  now?: () => number;
}

/**
 * Build the `FilterSource` that resolves a follow timeline's authors.
 *
 * Runs between connect and subscribe: fetches the subject's kind 3 through the
 * one-shot helper (EOSE grace, newest-version-wins and a watchdog all matter
 * here — see `one-shot-request.ts`), then hands the controller the timeline
 * filter built from it.
 *
 * **Returns an empty list rather than an unfiltered kind 1 filter** when there
 * is no follow list to work from. That is the single most important line in
 * this file: a fallback to `{"kinds":[1],"limit":50}` would ask the upstream
 * relays for the global feed, on behalf of a page whose author only wanted one
 * person's home timeline. An empty `authors` array is not sent either — this
 * repository alone interprets it three different ways, and every one of them
 * still forwards the REQ upstream (`doc/plan/follow-timeline.md` §6).
 */
export function followFilterSource(options: FollowFilterSourceOptions): FilterSource {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return async ({ connection, signal, setFollows, watchValidation }) => {
    setFollows({ status: 'resolving', count: 0, truncated: 0 });

    // No `limit`: kind 3 is replaceable, so there is exactly one event per
    // (pubkey, kind) to ask for. A `limit` would pass the freshness check too,
    // but leaving it off keeps the filter the plainest thing the gate can see.
    const event = await fetchLatestReplaceable(
      connection,
      { kinds: [3], authors: [options.pubkey] },
      { signal }
    );
    if (signal.aborted) {
      return [];
    }
    if (!event) {
      // Unpublished, absent upstream, or the watchdog fired. All three mean the
      // same thing to a reader, and none of them means "show me everything".
      setFollows({ status: 'missing', count: 0, truncated: 0 });
      return [];
    }

    const follows = parseFollowList(event);
    if (follows.length === 0) {
      setFollows({ status: 'missing', count: 0, truncated: 0 });
      return [];
    }

    const { authors, truncated } = selectAuthors(follows, options);
    // The relay verifies signatures in the background (LAZY), so the list that
    // decided this author set is still unverified here. A forged kind 3 with a
    // newer created_at picks the entire population the reader sees — and since
    // the follow list is fetched once and never re-read (§10), the relay
    // deleting it as invalid would otherwise leave the wrong timeline running.
    watchValidation(event.id, () =>
      setFollows({ status: 'invalid', count: authors.length, truncated })
    );
    setFollows({ status: 'ready', count: authors.length, truncated });

    const filter: Filter = { kinds: options.kinds, authors, limit: options.limit };
    if (options.sinceSeconds !== undefined && options.sinceSeconds > 0) {
      filter.since = now() - options.sinceSeconds;
    }
    return [filter];
  };
}
