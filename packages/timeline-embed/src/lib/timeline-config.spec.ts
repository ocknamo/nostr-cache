import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTHOR_LABEL, DEFAULT_NOTE_LABEL } from './event-actions.ts';
import { DEFAULT_OGP_PROXY } from './ogp.ts';
import { MAX_REACTIONS } from './reactions.ts';
import { MAX_REPLIES, MAX_REPLY_DEPTH } from './reply-tree.ts';
import {
  DEFAULT_KINDS,
  DEFAULT_LIMIT,
  configFromSearchParams,
  followConfigFromSearchParams,
  parseDebug,
  parseEnabled,
  parseFilter,
  parseFilters,
  parseFlag,
  parseFreshness,
  parseKinds,
  parseLimit,
  parseMaxEvents,
  parseMaxFollows,
  parseOgpProxy,
  parsePubkey,
  parseReactionsLimit,
  parseRelays,
  parseRepliesDepth,
  parseRepliesLimit,
  parseShowOriginAlias,
  parseSinceDays,
} from './timeline-config.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseRelays', () => {
  it('splits, trims and de-duplicates a comma-separated list', () => {
    expect(parseRelays(' wss://a.example , wss://b.example ,wss://a.example')).toEqual([
      'wss://a.example',
      'wss://b.example',
    ]);
  });

  it('returns an empty list for empty or missing input', () => {
    expect(parseRelays(undefined)).toEqual([]);
    expect(parseRelays(null)).toEqual([]);
    expect(parseRelays('')).toEqual([]);
    expect(parseRelays('  ,  ')).toEqual([]);
  });

  it('drops malformed and non-WebSocket URLs', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseRelays('not a url,https://relay.example,wss://ok.example')).toEqual([
      'wss://ok.example',
    ]);
  });

  it('drops ws:// upstreams on an https page because the browser blocks them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('location', { protocol: 'https:' });

    expect(parseRelays('ws://insecure.example,wss://ok.example')).toEqual(['wss://ok.example']);
    expect(warn.mock.calls[0][0]).toContain('mixed content');
  });

  it('keeps ws:// upstreams on an http page', () => {
    vi.stubGlobal('location', { protocol: 'http:' });

    expect(parseRelays('ws://localhost:8080')).toEqual(['ws://localhost:8080']);
  });
});

describe('parseFilter', () => {
  it('falls back to the defaults when nothing is given', () => {
    expect(parseFilter({})).toEqual({ kinds: DEFAULT_KINDS, limit: DEFAULT_LIMIT });
  });

  it('parses kinds, authors and limit', () => {
    expect(parseFilter({ kinds: '1, 6', authors: 'abc, def', limit: '20' })).toEqual({
      kinds: [1, 6],
      authors: ['abc', 'def'],
      limit: 20,
    });
  });

  it('omits authors entirely when none are given', () => {
    expect(parseFilter({ kinds: '1' })).not.toHaveProperty('authors');
  });

  it('ignores non-integer and negative kinds', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseFilter({ kinds: '1,abc,-2,1.5' }).kinds).toEqual([1]);
  });

  it('falls back to the default kinds when every kind is invalid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseFilter({ kinds: 'abc' }).kinds).toEqual(DEFAULT_KINDS);
  });

  it('falls back to the default limit for zero, negative and unparseable values', () => {
    expect(parseFilter({ limit: '0' }).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilter({ limit: '-5' }).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilter({ limit: 'lots' }).limit).toBe(DEFAULT_LIMIT);
    expect(parseFilter({ limit: '2.5' }).limit).toBe(DEFAULT_LIMIT);
  });
});

describe('parseFreshness', () => {
  it('parses whole seconds', () => {
    expect(parseFreshness('3600')).toBe(3600);
    expect(parseFreshness(' 60 ')).toBe(60);
  });

  it('reads zero as "no window" rather than as a missing value', () => {
    expect(parseFreshness('0')).toBe(0);
  });

  it('returns undefined for empty or missing input, leaving the default in place', () => {
    expect(parseFreshness(undefined)).toBeUndefined();
    expect(parseFreshness(null)).toBeUndefined();
    expect(parseFreshness('')).toBeUndefined();
    expect(parseFreshness('   ')).toBeUndefined();
  });

  it('warns and falls back to the default for negative and unparseable values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseFreshness('-1')).toBeUndefined();
    expect(parseFreshness('1.5')).toBeUndefined();
    expect(parseFreshness('a day')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('parseDebug', () => {
  it('is on for a bare flag and for an explicit true', () => {
    // `<nostr-timeline debug>` and `?debug` both arrive as an empty string.
    expect(parseDebug('')).toBe(true);
    expect(parseDebug('true')).toBe(true);
    expect(parseDebug('TRUE')).toBe(true);
    expect(parseDebug('1')).toBe(true);
  });

  it('is off when absent', () => {
    expect(parseDebug(null)).toBe(false);
    expect(parseDebug(undefined)).toBe(false);
  });

  it('accepts a real boolean, which is what a Svelte parent passes', () => {
    // `<nostr-timeline debug>` inside a Svelte component sets the custom
    // element's property, so the value arrives as `true` rather than `""`.
    expect(parseDebug(true)).toBe(true);
    expect(parseDebug(false)).toBe(false);
  });

  it('is off for anything that does not read as "on"', () => {
    expect(parseDebug('false')).toBe(false);
    expect(parseDebug('0')).toBe(false);
    expect(parseDebug('no')).toBe(false);
  });
});

describe('parseFlag', () => {
  it('is the general form the debug switch is built on', () => {
    // `parseDebug` delegates to it, so the two must agree on every spelling —
    // `reactions-open` reads exactly like `debug` does.
    for (const value of ['', 'true', 'TRUE', '1', 'false', '0', 'no', null, undefined]) {
      expect(parseFlag(value)).toBe(parseDebug(value));
    }
  });

  it('is off unless asked for', () => {
    expect(parseFlag(undefined)).toBe(false);
    expect(parseFlag('false')).toBe(false);
    // A bare `reactions-open` arrives as an empty string, as HTML boolean
    // attributes do.
    expect(parseFlag('')).toBe(true);
    // …and as a real boolean from a Svelte parent, which sets the property.
    expect(parseFlag(true)).toBe(true);
    expect(parseFlag(false)).toBe(false);
  });
});

describe('parseReactionsLimit', () => {
  it('reads a positive whole number', () => {
    expect(parseReactionsLimit('25')).toBe(25);
    expect(parseReactionsLimit(' 25 ')).toBe(25);
  });

  it('clamps rather than rejects an over-large request', () => {
    // An embed asking for more than the widget can hold has said "as many as
    // you can"; refusing the attribute would silently drop it to the default
    // instead, which is the smaller number.
    expect(parseReactionsLimit('99999')).toBe(MAX_REACTIONS);
    expect(parseReactionsLimit(String(MAX_REACTIONS))).toBe(MAX_REACTIONS);
  });

  it('leaves the default in place when nothing usable was given', () => {
    expect(parseReactionsLimit(undefined)).toBeUndefined();
    expect(parseReactionsLimit(null)).toBeUndefined();
    expect(parseReactionsLimit('')).toBeUndefined();
    expect(parseReactionsLimit('   ')).toBeUndefined();
  });

  it('refuses a limit that is not a count', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Zero would ask the relay for nothing at all, which is what
    // `show-reactions="false"` is for.
    expect(parseReactionsLimit('0')).toBeUndefined();
    expect(parseReactionsLimit('-5')).toBeUndefined();
    expect(parseReactionsLimit('1.5')).toBeUndefined();
    expect(parseReactionsLimit('lots')).toBeUndefined();
  });
});

describe('parseRepliesLimit', () => {
  it('reads a positive whole number', () => {
    expect(parseRepliesLimit('25')).toBe(25);
    expect(parseRepliesLimit(' 25 ')).toBe(25);
  });

  it('clamps rather than rejects an over-large request', () => {
    expect(parseRepliesLimit('99999')).toBe(MAX_REPLIES);
  });

  it('leaves the default in place when nothing usable was given', () => {
    expect(parseRepliesLimit(undefined)).toBeUndefined();
    expect(parseRepliesLimit('')).toBeUndefined();
    expect(parseRepliesLimit('   ')).toBeUndefined();
  });

  it('refuses a limit that is not a count', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Zero would ask the relay for nothing at all, which is what
    // `show-replies="false"` is for.
    expect(parseRepliesLimit('0')).toBeUndefined();
    expect(parseRepliesLimit('-5')).toBeUndefined();
    expect(parseRepliesLimit('1.5')).toBeUndefined();
    expect(parseRepliesLimit('lots')).toBeUndefined();
  });
});

describe('parseRepliesDepth', () => {
  it('reads a positive whole number', () => {
    expect(parseRepliesDepth('2')).toBe(2);
  });

  it('clamps at the depth the subscription budget allows', () => {
    // Each level is a live subscription and the relay caps a client at 20.
    expect(parseRepliesDepth('50')).toBe(MAX_REPLY_DEPTH);
  });

  it('leaves the default in place when nothing usable was given', () => {
    expect(parseRepliesDepth(undefined)).toBeUndefined();
    expect(parseRepliesDepth('')).toBeUndefined();
  });

  it('refuses a depth that is not a count', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseRepliesDepth('0')).toBeUndefined();
    expect(parseRepliesDepth('-1')).toBeUndefined();
    expect(parseRepliesDepth('deep')).toBeUndefined();
  });
});

describe('parseShowOriginAlias', () => {
  it('still turns the badges on for an explicit show-origin', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseShowOriginAlias('true')).toBe(true);
    expect(parseShowOriginAlias('')).toBe(true);
  });

  it('keeps them off for show-origin=false and for an absent attribute', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // An embed that never mentioned the attribute must get the new default;
    // only an explicit opt-in carries over.
    expect(parseShowOriginAlias(null)).toBe(false);
    expect(parseShowOriginAlias(undefined)).toBe(false);
    expect(parseShowOriginAlias('false')).toBe(false);
  });

  it('warns that the attribute is deprecated, once per page', async () => {
    // A fresh copy of the module, because the notice is deduplicated for the
    // life of the module and the specs above have already tripped it.
    vi.resetModules();
    const fresh = await import('./timeline-config.ts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fresh.parseShowOriginAlias('true');
    fresh.parseShowOriginAlias('true');

    // The element re-reads its props on every update, so warning per call would
    // fill the console of any page still using the old attribute.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('deprecated');
  });
});

describe('parseFilters', () => {
  it('wraps the comma-separated attributes when no filters JSON is given', () => {
    expect(parseFilters({ kinds: '1,6', limit: '20' })).toEqual([{ kinds: [1, 6], limit: 20 }]);
    expect(parseFilters({})).toEqual([{ kinds: DEFAULT_KINDS, limit: DEFAULT_LIMIT }]);
  });

  it('uses the filters JSON as given', () => {
    expect(parseFilters({ filters: '[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]' })).toEqual(
      [
        { kinds: [1], limit: 10 },
        { kinds: [6], limit: 5 },
      ]
    );
  });

  it('ignores kinds, authors and limit when filters is usable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      parseFilters({
        filters: '[{"kinds":[7],"limit":3}]',
        kinds: '1',
        authors: 'abc',
        limit: '99',
      })
    ).toEqual([{ kinds: [7], limit: 3 }]);
  });

  it('supplies the default limit to a filter that names none', () => {
    expect(parseFilters({ filters: '[{"kinds":[1]},{"kinds":[6],"limit":5}]' })).toEqual([
      { kinds: [1], limit: DEFAULT_LIMIT },
      { kinds: [6], limit: 5 },
    ]);
  });

  it('falls back to the attributes when every filter is unusable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseFilters({ filters: '{not json', kinds: '6', limit: '20' })).toEqual([
      { kinds: [6], limit: 20 },
    ]);
    expect(parseFilters({ filters: '[{"search":"hi"}]' })).toEqual([
      { kinds: DEFAULT_KINDS, limit: DEFAULT_LIMIT },
    ]);
  });
});

describe('configFromSearchParams', () => {
  it('accepts the deprecated show-origin as a way to ask for the badges', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(configFromSearchParams(new URLSearchParams('show-origin=true')).debug).toBe(true);
    expect(configFromSearchParams(new URLSearchParams('show-origin=false')).debug).toBe(false);
  });

  it('reads the same options the custom element takes as attributes', () => {
    const config = configFromSearchParams(
      new URLSearchParams(
        'relays=wss://a.example&kinds=1,7&authors=abc&limit=20&db-name=demo&profile-freshness=600&max-events=1000&debug=true'
      )
    );

    expect(config).toEqual({
      relays: ['wss://a.example'],
      filters: [{ kinds: [1, 7], authors: ['abc'], limit: 20 }],
      dbName: 'demo',
      profileFreshness: 600,
      maxEvents: 1000,
      debug: true,
      showAvatars: true,
      showMedia: true,
      showEmbeds: true,
      actions: [],
    });
  });

  it('reads the action bar out of the query string', () => {
    const config = configFromSearchParams(
      new URLSearchParams({ actions: '[{"id":"reply","label":"返信","icon":"💬"}]' })
    );

    // A URL cannot carry a handler, so the buttons arrive declarative and the
    // press comes back as an event — see `event-actions.ts`.
    expect(config.actions).toEqual([{ id: 'reply', label: '返信', icon: '💬' }]);
  });

  it('reads the author press out of the query string', () => {
    expect(
      configFromSearchParams(
        new URLSearchParams({ 'author-action': 'open-profile', 'author-action-label': '開く' })
      ).authorAction
    ).toEqual({ id: 'open-profile', label: '開く' });
    // Absent leaves the avatar and the name as they were.
    expect(configFromSearchParams(new URLSearchParams()).authorAction).toBeUndefined();
  });

  it('reads the quoted-note press out of the query string', () => {
    expect(
      configFromSearchParams(
        new URLSearchParams({ 'note-action': 'open-post', 'note-action-label': '投稿へ' })
      ).noteAction
    ).toEqual({ id: 'open-post', label: '投稿へ' });
    // Absent leaves the quote cards the plain frames they were.
    expect(configFromSearchParams(new URLSearchParams()).noteAction).toBeUndefined();
  });

  it('reads the filters JSON out of the query string', () => {
    const config = configFromSearchParams(
      new URLSearchParams({ filters: '[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]' })
    );

    expect(config.filters).toEqual([
      { kinds: [1], limit: 10 },
      { kinds: [6], limit: 5 },
    ]);
  });

  it('reads the link preview proxy, and leaves it unset by default', () => {
    expect(
      configFromSearchParams(new URLSearchParams('ogp-proxy=https://corsproxy.io/?key=abc'))
        .ogpProxy
    ).toBe('https://corsproxy.io/?key=abc');
    expect(configFromSearchParams(new URLSearchParams('ogp-proxy')).ogpProxy).toBe(
      DEFAULT_OGP_PROXY
    );
    expect(configFromSearchParams(new URLSearchParams('')).ogpProxy).toBeUndefined();
    expect(followConfigFromSearchParams(new URLSearchParams('')).ogpProxy).toBeUndefined();
  });

  it('turns media off only when asked', () => {
    expect(configFromSearchParams(new URLSearchParams('show-media=false')).showMedia).toBe(false);
    expect(configFromSearchParams(new URLSearchParams('show-media=true')).showMedia).toBe(true);
  });

  it('turns nested quotes off only when asked', () => {
    expect(configFromSearchParams(new URLSearchParams('show-embeds=false')).showEmbeds).toBe(false);
    expect(configFromSearchParams(new URLSearchParams('show-embeds=true')).showEmbeds).toBe(true);
  });

  it('keeps the debug badges off and takes no explicit database name by default', () => {
    const config = configFromSearchParams(new URLSearchParams(''));

    expect(config.debug).toBe(false);
    expect(config.showAvatars).toBe(true);
    expect(config.showMedia).toBe(true);
    expect(config.showEmbeds).toBe(true);
    expect(config.dbName).toBeUndefined();
    expect(config.profileFreshness).toBeUndefined();
    expect(config.relays).toEqual([]);
    expect(config.filters).toEqual([{ kinds: DEFAULT_KINDS, limit: DEFAULT_LIMIT }]);
  });
});

describe('parsePubkey', () => {
  const HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
  const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';

  it('accepts the spellings an embedder copies out of a client', () => {
    expect(parsePubkey(HEX)).toBe(HEX);
    expect(parsePubkey(NPUB)).toBe(HEX);
    expect(parsePubkey(` ${NPUB} `)).toBe(HEX);
  });

  it('lowercases hex so the filter matches what the relay stores', () => {
    expect(parsePubkey(HEX.toUpperCase())).toBe(HEX);
  });

  it('rejects anything that is not a pubkey, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Unlike every other attribute, this one has no default to fall back to:
    // the caller has to stop rather than subscribe to something else.
    expect(parsePubkey('nope')).toBeUndefined();
    expect(
      parsePubkey('note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')
    ).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('treats an absent value as absent rather than invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parsePubkey(undefined)).toBeUndefined();
    expect(parsePubkey('  ')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseKinds and parseLimit', () => {
  it('fall back to the widget defaults', () => {
    expect(parseKinds(undefined)).toEqual(DEFAULT_KINDS);
    expect(parseKinds('')).toEqual(DEFAULT_KINDS);
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('0')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('nope')).toBe(DEFAULT_LIMIT);
  });

  it('read what was given', () => {
    expect(parseKinds('1, 6')).toEqual([1, 6]);
    expect(parseLimit('20')).toBe(20);
  });
});

describe('parseMaxFollows', () => {
  it('reads a positive whole number', () => {
    expect(parseMaxFollows('500')).toBe(500);
  });

  it('leaves the default in place for anything unusable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Zero especially: "follow nobody" would leave the timeline with no authors
    // at all, which is the one filter shape this widget must never send.
    expect(parseMaxFollows('0')).toBeUndefined();
    expect(parseMaxFollows('-1')).toBeUndefined();
    expect(parseMaxFollows('1.5')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('says nothing when the attribute is simply absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseMaxFollows(undefined)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseMaxEvents', () => {
  it('reads a whole number of events', () => {
    expect(parseMaxEvents('20000')).toBe(20_000);
  });

  it('reads zero as "no ceiling" rather than an empty cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseMaxEvents('0')).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the default ceiling in place for anything unusable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A typo must cost the reader the default ceiling, not an unbounded
    // database on the embedding site's origin.
    expect(parseMaxEvents('-1')).toBeUndefined();
    expect(parseMaxEvents('1.5')).toBeUndefined();
    expect(parseMaxEvents('lots')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('says nothing when the attribute is simply absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseMaxEvents(undefined)).toBeUndefined();
    expect(parseMaxEvents('')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseOgpProxy', () => {
  it('opts in at the default proxy for a bare attribute', () => {
    expect(parseOgpProxy('')).toBe(DEFAULT_OGP_PROXY);
    expect(parseOgpProxy('true')).toBe(DEFAULT_OGP_PROXY);
    expect(parseOgpProxy(true)).toBe(DEFAULT_OGP_PROXY);
  });

  it('keeps a named proxy as it was written, API key and all', () => {
    expect(parseOgpProxy('https://corsproxy.io/?key=abc')).toBe('https://corsproxy.io/?key=abc');
  });

  it('leaves previews off when they are turned off', () => {
    expect(parseOgpProxy('false')).toBeUndefined();
    expect(parseOgpProxy(false)).toBeUndefined();
  });

  it('leaves previews off for anything that is not an http(s) URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseOgpProxy('javascript:alert(1)')).toBeUndefined();
    expect(parseOgpProxy('not a url')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the attribute is simply absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseOgpProxy(undefined)).toBeUndefined();
    expect(parseOgpProxy(null)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseSinceDays', () => {
  it('converts whole days to seconds', () => {
    expect(parseSinceDays('30')).toBe(30 * 86_400);
  });

  it('is off unless asked for', () => {
    expect(parseSinceDays(undefined)).toBeUndefined();
    expect(parseSinceDays('')).toBeUndefined();
  });

  it('warns and stays off for an unusable value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseSinceDays('0')).toBeUndefined();
    expect(parseSinceDays('-7')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('parseEnabled', () => {
  it('is on unless explicitly turned off', () => {
    expect(parseEnabled(undefined)).toBe(true);
    expect(parseEnabled('')).toBe(true);
    expect(parseEnabled('true')).toBe(true);
    expect(parseEnabled('false')).toBe(false);
  });

  it('accepts a real boolean from a Svelte parent setting the property', () => {
    expect(parseEnabled(false)).toBe(false);
    expect(parseEnabled(true)).toBe(true);
  });
});

describe('followConfigFromSearchParams', () => {
  const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
  const HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

  it('reads the same options the custom element takes as attributes', () => {
    const config = followConfigFromSearchParams(
      new URLSearchParams(
        `pubkey=${NPUB}&relays=wss://a.example&kinds=1&limit=20&max-follows=100&include-self=false&since-days=7&follows-freshness=900&profile-freshness=600&db-name=demo&max-events=1000&debug=true`
      )
    );

    expect(config).toEqual({
      relays: ['wss://a.example'],
      pubkey: HEX,
      kinds: [1],
      limit: 20,
      maxFollows: 100,
      includeSelf: false,
      sinceSeconds: 7 * 86_400,
      dbName: 'demo',
      profileFreshness: 600,
      followsFreshness: 900,
      maxEvents: 1000,
      debug: true,
      showAvatars: true,
      showMedia: true,
      showEmbeds: true,
      actions: [],
    });
  });

  it('leaves every optional setting to its default', () => {
    const config = followConfigFromSearchParams(new URLSearchParams(''));

    expect(config.pubkey).toBeUndefined();
    expect(config.kinds).toEqual(DEFAULT_KINDS);
    expect(config.limit).toBe(DEFAULT_LIMIT);
    expect(config.maxFollows).toBeUndefined();
    expect(config.includeSelf).toBe(true);
    expect(config.sinceSeconds).toBeUndefined();
    expect(config.followsFreshness).toBeUndefined();
    expect(config.maxEvents).toBeUndefined();
    expect(config.debug).toBe(false);
    expect(config.authorAction).toBeUndefined();
  });

  it('reads the author press, as the timeline reader does', () => {
    expect(
      followConfigFromSearchParams(new URLSearchParams({ 'author-action': 'open-profile' }))
        .authorAction
    ).toEqual({ id: 'open-profile', label: DEFAULT_AUTHOR_LABEL });
  });

  it('reads the quoted-note press, as the timeline reader does', () => {
    expect(
      followConfigFromSearchParams(new URLSearchParams({ 'note-action': 'open-post' })).noteAction
    ).toEqual({ id: 'open-post', label: DEFAULT_NOTE_LABEL });
  });

  it('does not accept the deprecated show-origin alias', () => {
    // A new element inherits no legacy spellings; `debug` is the only switch.
    expect(followConfigFromSearchParams(new URLSearchParams('show-origin=true')).debug).toBe(false);
  });
});
