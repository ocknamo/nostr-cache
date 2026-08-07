/**
 * NIP-02 (kind 3, follow list) knowledge, kept in one place.
 *
 * The parsing is pure functions over an event, so the NIP-02 rules can be
 * tested without a DOM or a relay; `followFilterSource` is the thin adapter
 * that turns them into the `FilterSource` the controller calls between
 * connecting and subscribing. See `doc/plan/follow-timeline.md` §4 for why the
 * controller is deliberately left ignorant of all of this.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { FilterSource } from './timeline-controller.ts';

import { fetchLatestReplaceable } from './one-shot-request.ts';

/**
 * Follow-list entries put on the timeline REQ unless `max-follows` says fewer.
 *
 * A safety valve, not a tuning knob. Two real relays answered a 982-author
 * filter only ~10ms slower than a 500-author one (`doc/plan/follow-timeline.md`
 * §7.2), so a cap low enough to bite would drop a large share of someone's
 * follows without making anything faster — it would just be the *wrong*
 * timeline. The remaining reasons to cap are client-side (Dexie materializing
 * every matching row before applying `limit`, serialized ingest) and still
 * unmeasured, so this sits above any real follow list until they are measured.
 */
export const DEFAULT_MAX_FOLLOWS = 2000;

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Extract the followed pubkeys from a kind 3 event.
 *
 * Defensive throughout, because this is upstream-supplied data that decides the
 * whole timeline: a tag that is not `["p", <hex>]` is skipped rather than
 * taking the list down with it. The relay hint and petname NIP-02 allows after
 * the pubkey are ignored — see `doc/plan/follow-timeline.md` §10.
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
  pubkey: string;
  /** Cap on follow-list entries. The subject is counted separately. */
  maxFollows: number;
  includeSelf: boolean;
}

export interface SelectedAuthors {
  authors: string[];
  /** Follow-list entries dropped by `maxFollows`. */
  truncated: number;
}

/**
 * Turn a follow list into the `authors` of a timeline filter.
 *
 * Truncation takes the *first* entries. NIP-02 suggests appending new follows
 * at the end, which would make the tail the interesting part, but no client is
 * obliged to honour that and several do not — so no meaning is assumed for the
 * order either way.
 *
 * The subject is added after truncation and does not count against the cap:
 * `max-follows` reads as "how many people I follow", so having `include-self`
 * silently evict a follow would be a surprising way for the two to interact.
 */
export function selectAuthors(follows: string[], options: SelectAuthorsOptions): SelectedAuthors {
  const kept = follows.slice(0, Math.max(0, options.maxFollows));
  const truncated = follows.length - kept.length;
  const authors = new Set(kept);
  if (options.includeSelf) {
    // A Set because subjects who follow themselves are common enough to matter.
    authors.add(options.pubkey);
  }
  return { authors: [...authors], truncated };
}

export interface FollowFilterSourceOptions {
  /** Hex pubkey whose follow list drives the timeline. */
  pubkey: string;
  kinds: number[];
  limit: number;
  maxFollows: number;
  includeSelf: boolean;
  /**
   * When set, bound the timeline filter to the last N seconds.
   *
   * Trades completeness for a narrower local query: a quiet follow list
   * produces an empty timeline, and the reader cannot tell "nobody posted" from
   * "the window cut it off". Goes on the timeline filter only — a `since` makes
   * a filter ineligible for the freshness window (§8), which is the one thing
   * the kind 3 fetch depends on.
   */
  sinceSeconds?: number;
  /** Injectable so the `since` a spec sees is deterministic. */
  now?: () => number;
}

/**
 * Build the `FilterSource` that resolves a follow timeline's authors.
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
    // (pubkey, kind) to ask for, and the plainest filter is the one the relay's
    // freshness gate can act on.
    const event = await fetchLatestReplaceable(
      connection,
      { kinds: [3], authors: [options.pubkey] },
      { signal }
    );
    if (signal.aborted) {
      return [];
    }
    if (!event) {
      // Unpublished, absent upstream, or the watchdog fired. All three look the
      // same from here, and none of them means "show me everything".
      setFollows({ status: 'missing', count: 0, truncated: 0 });
      return [];
    }

    const follows = parseFollowList(event);
    if (follows.length === 0) {
      setFollows({ status: 'missing', count: 0, truncated: 0 });
      return [];
    }

    const { authors, truncated } = selectAuthors(follows, options);
    if (authors.length === 0) {
      // The list had entries and the cap threw them all away, so the guard above
      // does not cover this. Reachable only from a JS caller passing
      // `maxFollows: 0` with `includeSelf: false` — `parseMaxFollows` rejects a
      // zero attribute — but the alternative is emitting an empty `authors`.
      setFollows({ status: 'missing', count: 0, truncated });
      return [];
    }
    // The relay verifies signatures in the background, so the list that decided
    // this author set is still unverified. A forged kind 3 with a newer
    // created_at picks the entire population the reader sees, and the list is
    // fetched once and never re-read (§10) — so without this, the relay
    // detecting the forgery would not correct the screen.
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
