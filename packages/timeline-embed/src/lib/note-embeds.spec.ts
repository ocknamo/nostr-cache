import { describe, expect, it } from 'vitest';
import { type EntityPart, parseContent } from './content-parts.ts';
import {
  MAX_EMBEDS_PER_NOTE,
  MAX_EMBEDS_PER_TOP_NOTE,
  MAX_EMBED_DEPTH,
  embedKeys,
  embedTarget,
  eventIdTarget,
  noteSegments,
  segmentKey,
  segmentMedia,
  selectEmbeds,
  sourceKey,
  sourceTarget,
} from './note-embeds.ts';

const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
/** The same event as NOTE, written the other way — id, author and kind TLVs. */
const NEVENT =
  'nevent1qqs9cppf9vggqpfdty7ykh6wdu72pc8qukmkukeapcxu6j7trd487ygpzamhxue69uhhyetvv9ujuetcv9khqmr99e3k7mgzypl8a8zz4ydlauvl4y57tldpkuhqa0q6fsg5zee7y72zxnvx4h05uqcyqqqqqqg4dxgkd';
/** kind 30023, author NPUB_HEX, `d` tag `my-article`. */
const NADDR =
  'naddr1qq9x67fdv9e8g6trd3jsz9mhwden5te0wfjkccte9ejhsctdwpkx2tnrdaksygr706wy92gmlmcel2ffuh76rdewp67p5nq3g9nnufu5ydxcdtwlfcpsgqqqw4rstnle8h';
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
/**
 * Distinct event ids, so a body can reference more than one thing — and enough
 * of them to overrun the larger of the two caps.
 */
const OTHER_NOTES = [
  'note1424242424242424242424242424242424242424242424242424qv3q9y6',
  'note1hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwashyvgw5',
  'note1enxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxqzqztj2',
  'note1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqskcx45n',
  'note1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqmwpjpm',
  'note1qvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvps7ucghe',
  'note1qszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszq0skkn7',
  'note1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2z0v9u',
  'note1qcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrq85gts5',
  'note1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurszx33xk',
  'note1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq6x97uv',
  'note1pyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysl5uy2w',
];

/** The single entity a one-reference body parses to. */
function entityOf(content: string): EntityPart {
  const part = parseContent(content).find((candidate) => candidate.kind === 'entity');
  if (!part) {
    throw new Error(`no entity in ${content}`);
  }
  return part;
}

describe('eventIdTarget', () => {
  it('keys a bare id the way the entity for the same event is keyed', () => {
    expect(eventIdTarget(NOTE_HEX)).toEqual(embedTarget(entityOf(NOTE).entity));
  });
});

describe('sourceTarget', () => {
  it('resolves an id and the entity for the same event alike', () => {
    const entity = { kind: 'entity', part: entityOf(NOTE) } as const;

    expect(sourceTarget({ kind: 'id', id: NOTE_HEX })).toEqual(sourceTarget(entity));
    expect(sourceKey({ kind: 'id', id: NOTE_HEX })).toBe(sourceKey(entity));
  });

  it('has nothing to resolve for a person', () => {
    expect(sourceTarget({ kind: 'entity', part: entityOf(NPUB) })).toBeUndefined();
  });
});

describe('embedTarget', () => {
  it('asks for a note by its id', () => {
    expect(embedTarget(entityOf(NOTE).entity)).toEqual({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
    });
  });

  it('asks for an nevent by its id alone, ignoring the kind hint', () => {
    // The kind TLV is written by whoever encoded the entity; a wrong one would
    // turn a fetchable event into a permanent "missing".
    expect(embedTarget(entityOf(NEVENT).entity)).toEqual({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
    });
  });

  it('asks for an naddr by its coordinate', () => {
    expect(embedTarget(entityOf(NADDR).entity)).toEqual({
      key: `30023:${NPUB_HEX}:my-article`,
      filter: { kinds: [30023], authors: [NPUB_HEX], '#d': ['my-article'] },
      replaceable: true,
    });
  });

  it('has no lookup for a person', () => {
    expect(embedTarget(entityOf(NPUB).entity)).toBeUndefined();
  });
});

describe('selectEmbeds', () => {
  it('picks the event references out of a body, in order', () => {
    const parts = parseContent(`a nostr:${NOTE} b nostr:${OTHER_NOTES[0]}`);
    expect(selectEmbeds(parts, 0).map((part) => part.raw)).toEqual([
      `nostr:${NOTE}`,
      `nostr:${OTHER_NOTES[0]}`,
    ]);
  });

  it('never picks a person', () => {
    expect(selectEmbeds(parseContent(`hi nostr:${NPUB}`), 0)).toEqual([]);
  });

  it('renders one card for an event referenced twice', () => {
    const parts = parseContent(`${NOTE} and nostr:${NEVENT}`);
    const selected = selectEmbeds(parts, 0);
    expect(selected).toHaveLength(1);
    expect(selected[0].raw).toBe(NOTE);
  });

  // Pinned, not derived: the caps are a product decision — ten references shown
  // on the note the reader opened, two inside each quote below it — so a change
  // to either should fail here and be made deliberately.
  it('caps a timeline card at ten and a quote at two', () => {
    expect(MAX_EMBEDS_PER_TOP_NOTE).toBe(10);
    expect(MAX_EMBEDS_PER_NOTE).toBe(2);
  });

  it('stops at the larger cap on a timeline card', () => {
    const parts = parseContent([NOTE, ...OTHER_NOTES].join(' '));
    expect(parts.filter((part) => part.kind === 'entity').length).toBeGreaterThan(
      MAX_EMBEDS_PER_TOP_NOTE
    );
    expect(selectEmbeds(parts, 0)).toHaveLength(MAX_EMBEDS_PER_TOP_NOTE);
  });

  it('stops at the smaller cap inside a quote', () => {
    const parts = parseContent([NOTE, ...OTHER_NOTES].join(' '));
    expect(selectEmbeds(parts, 1)).toHaveLength(MAX_EMBEDS_PER_NOTE);
  });

  it('embeds nothing at the depth cap', () => {
    const parts = parseContent(`nostr:${NOTE}`);
    expect(selectEmbeds(parts, MAX_EMBED_DEPTH - 1)).toHaveLength(1);
    expect(selectEmbeds(parts, MAX_EMBED_DEPTH)).toEqual([]);
  });
});

describe('embedKeys', () => {
  it('keys the selected entities', () => {
    const parts = parseContent(`a nostr:${NOTE} b ${NADDR}`);
    expect(embedKeys(selectEmbeds(parts, 0))).toEqual(
      new Set([NOTE_HEX, `30023:${NPUB_HEX}:my-article`])
    );
  });
});

describe('noteSegments', () => {
  it('returns one text segment covering everything when nothing is embedded', () => {
    const parts = parseContent(`hi nostr:${NOTE}`);
    expect(noteSegments(parts, new Set())).toEqual([{ kind: 'text', parts }]);
  });

  it('alternates text and card segments in source order', () => {
    const parts = parseContent(`No1: ${NOTE}\nNo2: ${OTHER_NOTES[0]}`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'embed', 'text', 'embed']);
    expect(segments[1]).toEqual({ kind: 'embed', part: entityOf(NOTE) });
    expect(segments[3]).toEqual({ kind: 'embed', part: entityOf(OTHER_NOTES[0]) });
  });

  it('starts with a card and no leading empty text segment when the body opens with one', () => {
    const parts = parseContent(`${NOTE} then some text`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments[0]).toEqual({ kind: 'embed', part: entityOf(NOTE) });
    expect(segments).toHaveLength(2);
  });

  it('places one card for an event referenced twice, at its first position', () => {
    // NOTE and NEVENT name the same event, so `selectEmbeds` keys them as one
    // card — the second mention must not become a second card.
    const parts = parseContent(`${NOTE} and nostr:${NEVENT} again`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments.filter((segment) => segment.kind === 'embed')).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'embed', part: entityOf(NOTE) });
    // The second mention stays in the trailing text run, for NoteContent's own
    // lift (by key) to remove — the same disappearing-not-chip behaviour the
    // pre-existing dedup already gave a note quoted twice.
    const trailing = segments[1];
    if (trailing.kind !== 'text') {
      throw new Error('expected a trailing text segment');
    }
    expect(trailing.parts.some((part) => part.kind === 'entity')).toBe(true);
  });

  it('produces no text segment between two references with only whitespace between them', () => {
    const parts = parseContent(`${NOTE}\n${OTHER_NOTES[0]}`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    // Not `['embed', 'text', 'embed']`: a run that is only the newline
    // between the two references renders nothing, so it must not become a
    // segment at all — see `--nt-embed-gap` margin collapsing in
    // EventCard.svelte, which only has to reason about adjacent `.embed`s.
    expect(segments.map((segment) => segment.kind)).toEqual(['embed', 'embed']);
  });

  it('produces no text segment for a run of only a repeat reference', () => {
    // NOTE and NEVENT name the same event: the second mention is lifted out
    // of the text by NoteContent, so a run holding nothing else renders
    // nothing and must not become a segment.
    const parts = parseContent(`${NOTE} ${NEVENT} ${OTHER_NOTES[0]}`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments.map((segment) => segment.kind)).toEqual(['embed', 'embed']);
  });

  it('leaves references past the cap in the trailing text segment as chips', () => {
    const parts = parseContent([NOTE, ...OTHER_NOTES].join(' '));
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments.filter((segment) => segment.kind === 'embed')).toHaveLength(
      MAX_EMBEDS_PER_TOP_NOTE
    );
    const trailing = segments[segments.length - 1];
    if (trailing.kind !== 'text') {
      throw new Error('expected a trailing text segment');
    }
    // OTHER_NOTES has more references than the cap leaves room for, so at
    // least one stays an in-text chip rather than becoming a card.
    expect(trailing.parts.some((part) => part.kind === 'entity')).toBe(true);
  });
});

describe('segmentMedia', () => {
  it('dedups a URL repeated across the segments a card split the body into', () => {
    const url = 'https://cdn.example.com/a.jpg';
    const parts = parseContent(`${url} ${NOTE} again ${url}`);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    const media = segmentMedia(segments);
    // One `MediaPart` in total, not one per segment it was written in — the
    // second mention of the same URL must not be shown, and re-fetched,
    // again after the card.
    expect(media.flat()).toHaveLength(1);
    expect(media.flat()[0].url).toBe(url);
    // It belongs to the first segment, where the URL was actually written.
    expect(media[0]).toEqual([{ kind: 'media', media: 'image', url }]);
  });

  it('has nothing for an embed segment', () => {
    const parts = parseContent(NOTE);
    const embedded = embedKeys(selectEmbeds(parts, 0));
    const segments = noteSegments(parts, embedded);

    expect(segments.map((segment) => segment.kind)).toEqual(['embed']);
    expect(segmentMedia(segments)).toEqual([[]]);
  });

  it('returns the same lists however many times it is called', () => {
    // The dedup set is built per call. A `$derived` re-evaluating this must
    // not find the URLs already "seen" from the previous run and drop them.
    const parts = parseContent(`https://cdn.example.com/a.jpg ${NOTE} tail`);
    const segments = noteSegments(parts, embedKeys(selectEmbeds(parts, 0)));

    const once = segmentMedia(segments);
    expect(once.flat()).toHaveLength(1);
    expect(segmentMedia(segments)).toEqual(once);
    expect(segmentMedia(segments)).toEqual(once);
  });
});

describe('segmentKey', () => {
  it('keys an embed by the event it names, not by its position', () => {
    const parts = parseContent(`a ${NOTE} b`);
    const segments = noteSegments(parts, embedKeys(selectEmbeds(parts, 0)));

    expect(segmentKey(segments[1], 1)).toBe(NOTE_HEX);
    // Moving the same reference to another index keeps its key, so the card
    // is never re-created — nor handed another card's in-flight request.
    expect(segmentKey(segments[1], 7)).toBe(NOTE_HEX);
  });

  it('cannot collide a text key with an embed one', () => {
    const parts = parseContent(`a ${NOTE} b`);
    const segments = noteSegments(parts, embedKeys(selectEmbeds(parts, 0)));
    const keys = segments.map(segmentKey);

    expect(new Set(keys).size).toBe(keys.length);
    // An embedKey is 64 hex characters or `kind:pubkey:d`; neither can start
    // with the prefix the text runs use.
    expect(keys.filter((key) => key.startsWith('text-'))).toEqual(['text-0', 'text-2']);
  });
});
