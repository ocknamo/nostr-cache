import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePostTarget } from './post-target.ts';

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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every rejection warns; the tests below do not care about the console. */
function silenceWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('parsePostTarget', () => {
  it('reads a raw hex id', () => {
    expect(parsePostTarget({ eventId: NOTE_HEX })).toEqual({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
      match: { id: NOTE_HEX },
    });
  });

  it('accepts an upper-case hex id, since hex has no case', () => {
    expect(parsePostTarget({ eventId: NOTE_HEX.toUpperCase() })?.filter).toEqual({
      ids: [NOTE_HEX],
    });
  });

  it('reads a note1', () => {
    expect(parsePostTarget({ eventId: NOTE })).toEqual({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
      match: { id: NOTE_HEX },
    });
  });

  it('reads an nevent as the id alone, ignoring its kind and author hints', () => {
    // The TLVs are written by whoever encoded the entity, and a wrong one would
    // turn a fetchable event into a permanent "not found" — the same reasoning
    // `embedTarget` uses for a quoted event.
    expect(parsePostTarget({ eventId: NEVENT })?.filter).toEqual({ ids: [NOTE_HEX] });
  });

  it('reads an naddr as a coordinate', () => {
    const address = `30023:${NPUB_HEX}:my-article`;
    expect(parsePostTarget({ eventId: NADDR })).toEqual({
      key: address,
      filter: { kinds: [30023], authors: [NPUB_HEX], '#d': ['my-article'] },
      replaceable: true,
      match: { address },
    });
  });

  it('trims whitespace, which an attribute written over two lines carries', () => {
    expect(parsePostTarget({ eventId: `  ${NOTE}\n` })?.key).toBe(NOTE_HEX);
  });

  it('builds the coordinate from author / kind / identifier', () => {
    const address = `30023:${NPUB_HEX}:my-article`;
    expect(parsePostTarget({ author: NPUB, kind: '30023', identifier: 'my-article' })).toEqual({
      key: address,
      filter: { kinds: [30023], authors: [NPUB_HEX], '#d': ['my-article'] },
      replaceable: true,
      match: { address },
    });
  });

  it('reads a missing identifier as the empty one, which NIP-01 allows', () => {
    expect(parsePostTarget({ author: NPUB_HEX, kind: '30023' })?.filter).toEqual({
      kinds: [30023],
      authors: [NPUB_HEX],
      '#d': [''],
    });
  });

  it('prefers event-id over the coordinate attributes when both are given', () => {
    const target = parsePostTarget({
      eventId: NOTE,
      author: NPUB,
      kind: '30023',
      identifier: 'my-article',
    });
    expect(target?.filter).toEqual({ ids: [NOTE_HEX] });
  });

  it('refuses an npub, which names a person rather than a post', () => {
    const warn = silenceWarnings();
    expect(parsePostTarget({ eventId: NPUB })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('names a person'));
  });

  it('refuses a bech32 string that does not decode', () => {
    silenceWarnings();
    expect(parsePostTarget({ eventId: 'note1notarealnote' })).toBeUndefined();
  });

  it('refuses hex of the wrong length rather than asking for it', () => {
    silenceWarnings();
    // Would otherwise reach `decodeNip19` and be rejected there anyway, but the
    // point is that a truncated id never becomes a filter.
    expect(parsePostTarget({ eventId: NOTE_HEX.slice(0, 63) })).toBeUndefined();
  });

  it('refuses an empty kind rather than reading it as kind 0', () => {
    silenceWarnings();
    // `Number('')` is 0, so a lax parse would build `{kinds:[0],…}` and render
    // the author's *profile* as the post.
    expect(parsePostTarget({ author: NPUB_HEX, kind: '' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX, kind: '  ' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX })).toBeUndefined();
    // …and the same for the other spellings `Number()` accepts.
    expect(parsePostTarget({ author: NPUB_HEX, kind: '0x1e' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX, kind: '3e1' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX, kind: ' 30023 ' })?.filter).toEqual({
      kinds: [30023],
      authors: [NPUB_HEX],
      '#d': [''],
    });
  });

  it('refuses a coordinate with an unusable author or kind', () => {
    silenceWarnings();
    expect(parsePostTarget({ author: 'not-a-pubkey', kind: '30023' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX, kind: 'article' })).toBeUndefined();
    expect(parsePostTarget({ author: NPUB_HEX, kind: '-1' })).toBeUndefined();
  });

  it('returns nothing when the element was given nothing', () => {
    // Rendered as a notice rather than as a wider query: there is no sensible
    // fallback filter for a detail view.
    expect(parsePostTarget({})).toBeUndefined();
    expect(parsePostTarget({ eventId: '   ' })).toBeUndefined();
    expect(parsePostTarget({ kind: '30023', identifier: 'my-article' })).toBeUndefined();
  });
});
