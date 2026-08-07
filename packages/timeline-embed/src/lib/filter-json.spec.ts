import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILTERS, parseFilterList } from './filter-json.ts';

// NIP-19 公式テストベクタと、shared 側の spec と同じ自前ベクタを使う
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NPROFILE =
  'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';
const NPROFILE_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';

/** Silence the warnings the sanitizer emits, and let a test assert on them. */
function captureWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseFilterList', () => {
  it('returns undefined when nothing is given', () => {
    expect(parseFilterList(undefined)).toBeUndefined();
    expect(parseFilterList(null)).toBeUndefined();
    expect(parseFilterList('')).toBeUndefined();
    expect(parseFilterList('   ')).toBeUndefined();
  });

  it('keeps every filter in the array, in order', () => {
    expect(parseFilterList('[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]')).toEqual([
      { kinds: [1], limit: 10 },
      { kinds: [6], limit: 5 },
    ]);
  });

  it('passes through the NIP-01 scalar fields', () => {
    expect(parseFilterList('[{"kinds":[1],"since":1700000000,"until":1700003600}]')).toEqual([
      { kinds: [1], since: 1700000000, until: 1700003600 },
    ]);
  });

  it('leaves limit unset so the caller can supply the widget default', () => {
    expect(parseFilterList('[{"kinds":[1]}]')).toEqual([{ kinds: [1] }]);
  });

  it('converts npub and nprofile authors to hex', () => {
    expect(parseFilterList(`[{"kinds":[1],"authors":["${NPUB}","${NPROFILE}"]}]`)).toEqual([
      { kinds: [1], authors: [NPUB_HEX, NPROFILE_HEX] },
    ]);
  });

  it('accepts hex authors and lowercases them', () => {
    expect(parseFilterList(`[{"authors":["${NPUB_HEX.toUpperCase()}"]}]`)).toEqual([
      { authors: [NPUB_HEX] },
    ]);
  });

  it('converts note ids in ids and #e to hex', () => {
    expect(parseFilterList(`[{"ids":["${NOTE}"]},{"kinds":[1],"#e":["${NOTE}"]}]`)).toEqual([
      { ids: [NOTE_HEX] },
      { kinds: [1], '#e': [NOTE_HEX] },
    ]);
  });

  it('converts #p the way it converts authors', () => {
    expect(parseFilterList(`[{"kinds":[1],"#p":["${NPUB}"]}]`)).toEqual([
      { kinds: [1], '#p': [NPUB_HEX] },
    ]);
  });

  it('leaves non-hex tag filters alone', () => {
    expect(parseFilterList('[{"kinds":[1],"#t":["nostr","bitcoin"],"limit":10}]')).toEqual([
      { kinds: [1], '#t': ['nostr', 'bitcoin'], limit: 10 },
    ]);
  });

  it('drops entries a hex field cannot use, keeping the rest', () => {
    const warn = captureWarnings();

    expect(parseFilterList(`[{"kinds":[1],"authors":["not-a-pubkey","${NPUB}"]}]`)).toEqual([
      { kinds: [1], authors: [NPUB_HEX] },
    ]);
    expect(warn.mock.calls[0][0]).toContain('not-a-pubkey');
  });

  it('drops the whole filter when a narrowing field loses every entry', () => {
    // Keeping `{kinds:[1]}` would turn "posts by this author" into "all posts".
    captureWarnings();

    expect(parseFilterList('[{"kinds":[1],"authors":["nope"]},{"kinds":[6]}]')).toEqual([
      { kinds: [6] },
    ]);
  });

  it('drops unsupported keys but keeps the filter', () => {
    const warn = captureWarnings();

    expect(parseFilterList('[{"kinds":[1],"search":"hello"}]')).toEqual([{ kinds: [1] }]);
    expect(warn.mock.calls[0][0]).toContain('search');
  });

  it('drops filters left with no condition to match on', () => {
    captureWarnings();

    expect(parseFilterList('[{"limit":10}]')).toBeUndefined();
    expect(parseFilterList('[{"search":"hello"}]')).toBeUndefined();
  });

  it('rejects a filter whose kinds are not usable numbers', () => {
    captureWarnings();

    expect(parseFilterList('[{"kinds":["1"]},{"kinds":[6]}]')).toEqual([{ kinds: [6] }]);
    expect(parseFilterList('[{"kinds":[]}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":[-1]}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":[1.5]},{"kinds":[1]}]')).toEqual([{ kinds: [1] }]);
  });

  it('rejects a filter whose scalar fields are not whole non-negative numbers', () => {
    captureWarnings();

    expect(parseFilterList('[{"kinds":[1],"limit":"10"}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":[1],"limit":0}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":[1],"since":-1}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":[1],"until":1.5}]')).toBeUndefined();
  });

  it('rejects a filter whose list fields are not arrays of strings', () => {
    captureWarnings();

    expect(parseFilterList('[{"authors":"abc"}]')).toBeUndefined();
    expect(parseFilterList('[{"#t":[1]}]')).toBeUndefined();
    expect(parseFilterList('[{"kinds":1}]')).toBeUndefined();
  });

  it('skips entries that are not filter objects', () => {
    captureWarnings();

    expect(parseFilterList('[null,"nope",[1],{"kinds":[1]}]')).toEqual([{ kinds: [1] }]);
  });

  it(`keeps only the first ${MAX_FILTERS} filters`, () => {
    const warn = captureWarnings();
    const raw = JSON.stringify(
      Array.from({ length: MAX_FILTERS + 3 }, (_, index) => ({ kinds: [index] }))
    );

    const filters = parseFilterList(raw);

    expect(filters).toHaveLength(MAX_FILTERS);
    expect(filters?.at(-1)).toEqual({ kinds: [MAX_FILTERS - 1] });
    expect(warn.mock.calls[0][0]).toContain(`first ${MAX_FILTERS}`);
  });

  it('returns undefined for input that is not a JSON array of filters', () => {
    const warn = captureWarnings();

    expect(parseFilterList('{not json')).toBeUndefined();
    expect(parseFilterList('{"kinds":[1]}')).toBeUndefined();
    expect(parseFilterList('[]')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
