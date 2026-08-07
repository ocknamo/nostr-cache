import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import {
  DEFAULT_MAX_FOLLOWS,
  type FollowFilterSourceOptions,
  followFilterSource,
  parseFollowList,
  selectAuthors,
} from './follow-list.ts';
import { DEFAULT_ONE_SHOT_GRACE_MS } from './one-shot-request.ts';
import type { RelayConnection } from './relay-connection.ts';
import type { FilterSource, FilterSourceContext, FollowsState } from './timeline-controller.ts';

/** A distinct, valid 64-character hex pubkey per index. */
function hex(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(32);
}

const SUBJECT = hex(0xaa);

function followEvent(pubkeys: string[], overrides: Partial<NostrEvent> = {}): NostrEvent {
  return makeEvent({
    kind: 3,
    pubkey: SUBJECT,
    tags: pubkeys.map((pubkey) => ['p', pubkey]),
    ...overrides,
  });
}

describe('parseFollowList', () => {
  it('reads the pubkeys out of the p tags', () => {
    expect(parseFollowList(followEvent([hex(1), hex(2)]))).toEqual([hex(1), hex(2)]);
  });

  it('keeps the order the event lists them in', () => {
    // Truncation takes from the front, so the order is not incidental.
    expect(parseFollowList(followEvent([hex(3), hex(1), hex(2)]))).toEqual([
      hex(3),
      hex(1),
      hex(2),
    ]);
  });

  it('lowercases hex so the filter matches what the relay stores', () => {
    expect(parseFollowList(followEvent([hex(0xab).toUpperCase()]))).toEqual([hex(0xab)]);
  });

  it('collapses a pubkey listed twice', () => {
    // The same author either way, so the REQ must not name them twice.
    const event = followEvent([hex(1), hex(1).toUpperCase(), hex(2)]);

    expect(parseFollowList(event)).toEqual([hex(1), hex(2)]);
  });

  it('skips malformed tags instead of dropping the whole list', () => {
    // Upstream-supplied data decides the entire timeline, so one broken tag
    // must not cost the reader every other follow.
    const event = followEvent([], {
      tags: [
        ['p'],
        ['p', 'not-hex'],
        ['p', hex(1)],
        ['e', hex(2)],
        ['p', ''],
        // Relay hint and petname are ignored, but must not disqualify the tag.
        ['p', hex(3), 'wss://relay.example', 'alice'],
      ],
    });

    expect(parseFollowList(event)).toEqual([hex(1), hex(3)]);
  });

  it('returns nothing for an event that is not a follow list', () => {
    expect(parseFollowList(makeEvent({ kind: 1, tags: [['p', hex(1)]] }))).toEqual([]);
  });

  it('returns nothing for a follow list with no p tags', () => {
    expect(parseFollowList(followEvent([]))).toEqual([]);
  });
});

describe('selectAuthors', () => {
  const base = { pubkey: SUBJECT, maxFollows: 10, includeSelf: false };

  it('passes a short list through untouched', () => {
    expect(selectAuthors([hex(1), hex(2)], base)).toEqual({
      authors: [hex(1), hex(2)],
      truncated: 0,
    });
  });

  it('truncates from the front and reports how many were dropped', () => {
    const result = selectAuthors([hex(1), hex(2), hex(3)], { ...base, maxFollows: 2 });

    expect(result).toEqual({ authors: [hex(1), hex(2)], truncated: 1 });
  });

  it('adds the subject when asked, without spending the cap on them', () => {
    const result = selectAuthors([hex(1), hex(2)], { ...base, maxFollows: 2, includeSelf: true });

    expect(result).toEqual({ authors: [hex(1), hex(2), SUBJECT], truncated: 0 });
  });

  it('does not list a self-following subject twice', () => {
    const result = selectAuthors([hex(1), SUBJECT], { ...base, includeSelf: true });

    expect(result.authors).toEqual([hex(1), SUBJECT]);
  });

  it('leaves the subject out when include-self is off', () => {
    expect(selectAuthors([hex(1)], base).authors).toEqual([hex(1)]);
  });
});

/**
 * The filter source is the piece that must never widen its query. Every path
 * that fails to produce a follow list has to end with no filters at all: a
 * fallback to `{"kinds":[1],"limit":50}` would ask the upstream relays for the
 * global feed on behalf of a page that only wanted one person's timeline.
 */
describe('followFilterSource', () => {
  const options: FollowFilterSourceOptions = {
    pubkey: SUBJECT,
    kinds: [1],
    limit: 50,
    maxFollows: DEFAULT_MAX_FOLLOWS,
    includeSelf: false,
  };

  interface Harness {
    context: FilterSourceContext;
    /** Every follows state the source reported, in order. */
    reported: FollowsState[];
    /** Filters the fake relay was asked for. */
    requested: Filter[][];
    /** Events watched for a deletion verdict, with their callbacks. */
    watched: { eventId: string; onInvalid: () => void }[];
  }

  /**
   * A connection that answers one REQ with the given events, then EOSE.
   *
   * Deliberately not a real relay: what is under test is the interpretation of
   * a kind 3 and the decision of what to subscribe with, both of which are pure
   * consequences of which events arrive.
   */
  function harness(events: NostrEvent[], signal?: AbortSignal): Harness {
    const reported: FollowsState[] = [];
    const requested: Filter[][] = [];
    const watched: { eventId: string; onInvalid: () => void }[] = [];
    const connection = {
      subscribe: (
        _subId: string,
        filters: Filter[],
        handlers: { onEvent: (event: NostrEvent) => void; onEose?: () => void }
      ) => {
        requested.push(filters);
        for (const event of events) {
          handlers.onEvent(event);
        }
        handlers.onEose?.();
      },
      unsubscribe: () => {},
    } as unknown as RelayConnection;

    return {
      context: {
        connection,
        signal: signal ?? new AbortController().signal,
        setFollows: (follows) => reported.push(follows),
        watchValidation: (eventId, onInvalid) => watched.push({ eventId, onInvalid }),
      },
      reported,
      requested,
      watched,
    };
  }

  /**
   * Run a source to completion.
   *
   * The one-shot fetch keeps listening after EOSE, so the source only settles
   * once that grace elapses. Fake timers keep the wait from being paid in
   * wall-clock time once per spec.
   */
  function resolve(source: FilterSource, context: FilterSourceContext): Promise<Filter[]> {
    const settled = source(context);
    return vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS).then(() => settled);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the follow list with no limit', async () => {
    const { context, requested } = harness([followEvent([hex(1)])]);

    await resolve(followFilterSource(options), context);

    expect(requested[0]).toEqual([{ kinds: [3], authors: [SUBJECT] }]);
  });

  it('builds the timeline filter from the follow list', async () => {
    const { context } = harness([followEvent([hex(1), hex(2)])]);

    const filters = await resolve(followFilterSource(options), context);

    expect(filters).toEqual([{ kinds: [1], authors: [hex(1), hex(2)], limit: 50 }]);
  });

  it('reports resolving before it reports the result', async () => {
    const { context, reported } = harness([followEvent([hex(1)])]);

    await resolve(followFilterSource(options), context);

    expect(reported.map((state) => state.status)).toEqual(['resolving', 'ready']);
    expect(reported.at(-1)).toEqual({ status: 'ready', count: 1, truncated: 0 });
  });

  it('opens no subscription when the follow list cannot be fetched', async () => {
    const { context, reported } = harness([]);

    const filters = await resolve(followFilterSource(options), context);

    // The one regression that matters most: unpublished, absent upstream and a
    // timed-out REQ all look identical from here, and none of them means "then
    // show me everything".
    expect(filters).toEqual([]);
    expect(reported.at(-1)).toEqual({ status: 'missing', count: 0, truncated: 0 });
  });

  it('opens no subscription when the follow list is empty', async () => {
    const { context, reported } = harness([followEvent([])]);

    const filters = await resolve(followFilterSource(options), context);

    // Not `{"kinds":[1],"authors":[]}` either: this repository reads an empty
    // authors array three different ways, and every one of them still forwards
    // the REQ upstream.
    expect(filters).toEqual([]);
    expect(reported.at(-1)?.status).toBe('missing');
  });

  it('opens no subscription when every p tag was unusable', async () => {
    const { context, reported } = harness([
      followEvent([], { tags: [['p'], ['p', 'nope'], ['e', hex(1)]] }),
    ]);

    expect(await resolve(followFilterSource(options), context)).toEqual([]);
    expect(reported.at(-1)?.status).toBe('missing');
  });

  it('opens no subscription when the cap threw every follow away', async () => {
    const { context, reported } = harness([followEvent([hex(1), hex(2)])]);

    // The "empty list" guard does not catch this: the list had entries and the
    // cap discarded all of them, which would leave the forbidden empty `authors`.
    const filters = await resolve(
      followFilterSource({ ...options, maxFollows: 0, includeSelf: false }),
      context
    );

    expect(filters).toEqual([]);
    expect(reported.at(-1)).toEqual({ status: 'missing', count: 0, truncated: 2 });
  });

  it('still subscribes when the cap drops every follow but self is included', async () => {
    const { context } = harness([followEvent([hex(1), hex(2)])]);

    const filters = await resolve(
      followFilterSource({ ...options, maxFollows: 0, includeSelf: true }),
      context
    );

    // The subject alone is a real (if narrow) author set, not an empty one.
    expect(filters).toEqual([{ kinds: [1], authors: [SUBJECT], limit: 50 }]);
  });

  it('keeps the newest copy when two relays answer with different versions', async () => {
    // Storage holds one copy, but two upstream relays can each deliver theirs,
    // and the first to land is not necessarily the newest.
    const { context } = harness([
      followEvent([hex(9)], { id: 'newest', created_at: 1_700_000_500 }),
      followEvent([hex(1)], { id: 'older', created_at: 1_700_000_100 }),
    ]);

    const filters = await resolve(followFilterSource(options), context);

    expect(filters[0].authors).toEqual([hex(9)]);
  });

  it('truncates at max-follows and says how many were dropped', async () => {
    const { context, reported } = harness([followEvent([hex(1), hex(2), hex(3)])]);

    const filters = await resolve(followFilterSource({ ...options, maxFollows: 2 }), context);

    expect(filters[0].authors).toEqual([hex(1), hex(2)]);
    expect(reported.at(-1)).toEqual({ status: 'ready', count: 2, truncated: 1 });
  });

  it('adds the subject when include-self is on', async () => {
    const { context, reported } = harness([followEvent([hex(1)])]);

    const filters = await resolve(followFilterSource({ ...options, includeSelf: true }), context);

    expect(filters[0].authors).toEqual([hex(1), SUBJECT]);
    expect(reported.at(-1)?.count).toBe(2);
  });

  it('leaves since off unless asked for', async () => {
    const { context } = harness([followEvent([hex(1)])]);

    const filters = await resolve(followFilterSource(options), context);

    expect(filters[0].since).toBeUndefined();
  });

  it('bounds the timeline filter when since is asked for', async () => {
    const { context } = harness([followEvent([hex(1)])]);

    const filters = await resolve(
      followFilterSource({ ...options, sinceSeconds: 86_400, now: () => 1_700_000_000 }),
      context
    );

    expect(filters[0].since).toBe(1_700_000_000 - 86_400);
  });

  it('never puts since on the follow-list request', async () => {
    const { context, requested } = harness([followEvent([hex(1)])]);

    await resolve(followFilterSource({ ...options, sinceSeconds: 86_400 }), context);

    // A `since` makes a filter ineligible for the relay's freshness window,
    // which is the one thing the kind 3 fetch depends on for a warm load.
    expect(requested[0][0].since).toBeUndefined();
  });

  it('watches the follow list for a deletion verdict', async () => {
    const { context, reported, watched } = harness([followEvent([hex(1)], { id: 'follow-list' })]);

    await resolve(followFilterSource(options), context);
    expect(watched).toEqual([{ eventId: 'follow-list', onInvalid: expect.any(Function) }]);

    watched[0].onInvalid();
    expect(reported.at(-1)).toEqual({ status: 'invalid', count: 1, truncated: 0 });
  });

  it('subscribes to nothing when it is aborted before it starts', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const { context, watched } = harness([followEvent([hex(1)])], aborted.signal);

    expect(await resolve(followFilterSource(options), context)).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('defaults the cap well above any real follow list', () => {
    expect(DEFAULT_MAX_FOLLOWS).toBeGreaterThanOrEqual(2000);
  });
});
