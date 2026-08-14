import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import type { PostTargetMatch } from './post-target.ts';
import {
  MAX_LISTED_REACTORS,
  MAX_REACTION_GROUPS,
  type Reaction,
  parseReaction,
  summarizeReactionEvents,
  summarizeReactions,
} from './reactions.ts';

const TARGET = 'aa00000000000000000000000000000000000000000000000000000000000001';
const OTHER = 'bb00000000000000000000000000000000000000000000000000000000000002';
const BY_ID: PostTargetMatch = { id: TARGET };

/** A kind 7 pointing at TARGET, with whatever content the test is about. */
function reaction(content: string, overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({
    kind: 7,
    content,
    tags: [['e', TARGET]],
    ...overrides,
  });
}

describe('parseReaction', () => {
  it('reads `+` as a like', () => {
    expect(parseReaction(reaction('+'), BY_ID)).toMatchObject({ kind: 'like', label: '❤️' });
  });

  it('reads empty content as a like, which is what NIP-25 says it means', () => {
    expect(parseReaction(reaction(''), BY_ID)).toMatchObject({ kind: 'like' });
    // Whitespace-only is the same case: it is empty once you look at it.
    expect(parseReaction(reaction('   '), BY_ID)).toMatchObject({ kind: 'like' });
  });

  it('reads `-` as a dislike', () => {
    expect(parseReaction(reaction('-'), BY_ID)).toMatchObject({ kind: 'dislike', label: '👎' });
  });

  it('keeps any other content as the glyph it is', () => {
    expect(parseReaction(reaction('🔥'), BY_ID)).toMatchObject({
      kind: 'emoji',
      key: '🔥',
      label: '🔥',
    });
  });

  it('groups `+` with a literal heart, because a reader cannot tell them apart', () => {
    const plus = parseReaction(reaction('+'), BY_ID);
    const heart = parseReaction(reaction('❤️'), BY_ID);
    expect(plus?.key).toBe(heart?.key);
  });

  it('resolves a NIP-30 shortcode to its published image', () => {
    const event = reaction(':soapstone:', {
      tags: [
        ['e', TARGET],
        ['emoji', 'soapstone', 'https://example.com/soapstone.png'],
      ],
    });

    expect(parseReaction(event, BY_ID)).toMatchObject({
      kind: 'custom',
      label: ':soapstone:',
      url: 'https://example.com/soapstone.png',
    });
  });

  it('keeps a shortcode with no emoji tag as text rather than dropping it', () => {
    const parsed = parseReaction(reaction(':soapstone:'), BY_ID);
    expect(parsed).toMatchObject({ kind: 'custom', label: ':soapstone:' });
    expect(parsed?.url).toBeUndefined();
  });

  it('refuses an emoji image that is not http(s)', () => {
    const event = reaction(':x:', {
      tags: [
        ['e', TARGET],
        ['emoji', 'x', 'data:image/png;base64,AAAA'],
      ],
    });
    // The reaction still counts; only the image is dropped.
    expect(parseReaction(event, BY_ID)?.url).toBeUndefined();
  });

  it('ignores anything that is not kind 7', () => {
    expect(parseReaction(reaction('+', { kind: 1 }), BY_ID)).toBeUndefined();
    expect(parseReaction(reaction('+', { kind: 6 }), BY_ID)).toBeUndefined();
  });

  it('ignores a reaction whose last `e` tag names another event', () => {
    // A reaction to a *reply*: NIP-10 puts the thread root in the tags too, so
    // the relay's `#e` filter delivers it here.
    const toReply = reaction('+', {
      tags: [
        ['e', TARGET],
        ['e', OTHER],
      ],
    });
    expect(parseReaction(toReply, BY_ID)).toBeUndefined();
  });

  it('accepts a reaction whose last `e` tag is ours even with an earlier one', () => {
    const toUs = reaction('+', {
      tags: [
        ['e', OTHER],
        ['e', TARGET],
      ],
    });
    expect(parseReaction(toUs, BY_ID)).toMatchObject({ kind: 'like' });
  });

  it('matches an addressable target on its `a` tag rather than an `e` tag', () => {
    const address = `30023:${'cc'.repeat(32)}:my-article`;
    const event = reaction('+', { tags: [['a', address]] });

    expect(parseReaction(event, { address })).toMatchObject({ kind: 'like' });
    // The same event is not a reaction to some event id, and an `e` tag on it
    // would not make it one.
    expect(parseReaction(event, BY_ID)).toBeUndefined();
  });

  it('strips control and bidi characters out of the glyph', () => {
    // A bidi override in a chip would reorder the text around it.
    expect(parseReaction(reaction('🔥‮'), BY_ID)).toMatchObject({ label: '🔥' });
  });

  it('drops content too long to be a glyph', () => {
    expect(parseReaction(reaction('x'.repeat(33)), BY_ID)).toBeUndefined();
  });

  it('drops content that is only unrenderable characters', () => {
    // Not read as a like: NIP-25's `+` is for an empty `content`, and this
    // author sent something — counting it as a heart would credit them with a
    // reaction they did not make.
    expect(parseReaction(reaction('‮‎'), BY_ID)).toBeUndefined();
  });

  it('ignores a target that names neither an id nor an address', () => {
    expect(parseReaction(reaction('+'), {})).toBeUndefined();
  });
});

/** A parsed reaction, for the grouping tests that do not care about events. */
function made(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: `r${Math.random()}`,
    pubkey: 'pk1',
    createdAt: 1000,
    kind: 'emoji',
    key: '🔥',
    label: '🔥',
    ...overrides,
  };
}

describe('summarizeReactions', () => {
  it('counts each glyph separately and totals them', () => {
    const summary = summarizeReactions([
      made({ id: 'a', pubkey: 'p1', key: '🔥', label: '🔥' }),
      made({ id: 'b', pubkey: 'p2', key: '🔥', label: '🔥' }),
      made({ id: 'c', pubkey: 'p3', key: '❤️', label: '❤️' }),
    ]);

    expect(summary.groups.map((group) => [group.key, group.count])).toEqual([
      ['🔥', 2],
      ['❤️', 1],
    ]);
    expect(summary.total).toBe(3);
  });

  it('counts a person once per glyph, keeping their newest', () => {
    const summary = summarizeReactions([
      made({ id: 'old', pubkey: 'p1', createdAt: 10 }),
      made({ id: 'new', pubkey: 'p1', createdAt: 20 }),
    ]);

    // NIP-25 has no retraction and the relay keeps every copy.
    expect(summary.groups[0].count).toBe(1);
    expect(summary.reactors.map((reactor) => reactor.id)).toEqual(['new']);
  });

  it('counts a person in each glyph they used', () => {
    const summary = summarizeReactions([
      made({ id: 'a', pubkey: 'p1', key: '🔥', label: '🔥' }),
      made({ id: 'b', pubkey: 'p1', key: '❤️', label: '❤️' }),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.groups).toHaveLength(2);
    // And gets a row per glyph in the list, because the row says which one.
    expect(summary.reactors.map((reactor) => [reactor.pubkey, reactor.key])).toEqual([
      ['p1', '❤️'],
      ['p1', '🔥'],
    ]);
  });

  it('does not depend on the order the reactions arrived in', () => {
    const older = made({ id: 'old', pubkey: 'p1', createdAt: 10 });
    const newer = made({ id: 'new', pubkey: 'p1', createdAt: 20 });

    expect(summarizeReactions([older, newer]).reactors[0].id).toBe('new');
    expect(summarizeReactions([newer, older]).reactors[0].id).toBe('new');
  });

  it('orders groups by count, then by the order they first appeared', () => {
    const summary = summarizeReactions([
      made({ id: 'a', pubkey: 'p1', key: '🔥', label: '🔥' }),
      made({ id: 'b', pubkey: 'p2', key: '❤️', label: '❤️' }),
      made({ id: 'c', pubkey: 'p3', key: '❤️', label: '❤️' }),
      made({ id: 'd', pubkey: 'p4', key: '👀', label: '👀' }),
    ]);

    // 🔥 and 👀 tie at one and keep first-seen order.
    expect(summary.groups.map((group) => group.key)).toEqual(['❤️', '🔥', '👀']);
  });

  it('takes the chip image from a reactor who published one', () => {
    const summary = summarizeReactions([
      made({ id: 'a', pubkey: 'p1', key: ':x:', label: ':x:' }),
      made({ id: 'b', pubkey: 'p2', key: ':x:', label: ':x:', url: 'https://example.com/x.png' }),
    ]);

    expect(summary.groups[0].url).toBe('https://example.com/x.png');
  });

  it('caps the chips but still totals everything', () => {
    const reactions = Array.from({ length: MAX_REACTION_GROUPS + 3 }, (_, index) =>
      made({ id: `r${index}`, pubkey: `p${index}`, key: `k${index}`, label: `k${index}` })
    );

    const summary = summarizeReactions(reactions);

    expect(summary.groups).toHaveLength(MAX_REACTION_GROUPS);
    expect(summary.hiddenGroups).toBe(3);
    // Not the sum of the chips that happened to fit.
    expect(summary.total).toBe(MAX_REACTION_GROUPS + 3);
  });

  it('lists every glyph in one list, newest first', () => {
    const summary = summarizeReactions([
      made({ id: 'a', pubkey: 'p1', createdAt: 10, key: '🔥', label: '🔥' }),
      made({ id: 'b', pubkey: 'p2', createdAt: 30, key: '❤️', label: '❤️' }),
      made({ id: 'c', pubkey: 'p3', createdAt: 20, key: '🔥', label: '🔥' }),
    ]);

    // Any chip opens this, so it is not grouped by glyph.
    expect(summary.reactors.map((reactor) => reactor.id)).toEqual(['b', 'c', 'a']);
  });

  it('lists the reactors of a glyph the chip cap left out', () => {
    const reactions = Array.from({ length: MAX_REACTION_GROUPS + 1 }, (_, index) =>
      made({ id: `r${index}`, pubkey: `p${index}`, key: `k${index}`, label: `k${index}` })
    );

    const summary = summarizeReactions(reactions);

    expect(summary.groups).toHaveLength(MAX_REACTION_GROUPS);
    expect(summary.reactors).toHaveLength(MAX_REACTION_GROUPS + 1);
  });

  it('caps the reactors listed without capping the counts', () => {
    const reactions = Array.from({ length: MAX_LISTED_REACTORS + 5 }, (_, index) =>
      made({ id: `r${index}`, pubkey: `p${index}` })
    );

    const summary = summarizeReactions(reactions);

    expect(summary.groups[0].count).toBe(MAX_LISTED_REACTORS + 5);
    expect(summary.reactors).toHaveLength(MAX_LISTED_REACTORS);
  });

  it('has nothing to say about a post nobody reacted to', () => {
    expect(summarizeReactions([])).toEqual({
      groups: [],
      reactors: [],
      total: 0,
      hiddenGroups: 0,
    });
  });
});

describe('summarizeReactionEvents', () => {
  it('skips the events that are not reactions to this post', () => {
    const summary = summarizeReactionEvents(
      [
        reaction('+', { id: 'r1', pubkey: 'p1' }),
        // Delivered because the relay matches any `e` tag.
        reaction('+', {
          id: 'r2',
          pubkey: 'p2',
          tags: [
            ['e', TARGET],
            ['e', OTHER],
          ],
        }),
        makeEvent({ id: 'r3', pubkey: 'p3', kind: 1 }),
      ],
      BY_ID
    );

    expect(summary.total).toBe(1);
  });
});
