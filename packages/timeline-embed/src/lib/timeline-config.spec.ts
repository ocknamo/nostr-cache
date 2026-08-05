import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KINDS,
  DEFAULT_LIMIT,
  configFromSearchParams,
  parseDebug,
  parseFilter,
  parseFreshness,
  parseRelays,
  parseShowOriginAlias,
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

describe('configFromSearchParams', () => {
  it('accepts the deprecated show-origin as a way to ask for the badges', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(configFromSearchParams(new URLSearchParams('show-origin=true')).debug).toBe(true);
    expect(configFromSearchParams(new URLSearchParams('show-origin=false')).debug).toBe(false);
  });

  it('reads the same options the custom element takes as attributes', () => {
    const config = configFromSearchParams(
      new URLSearchParams(
        'relays=wss://a.example&kinds=1,7&authors=abc&limit=20&db-name=demo&profile-freshness=600&debug=true'
      )
    );

    expect(config).toEqual({
      relays: ['wss://a.example'],
      filter: { kinds: [1, 7], authors: ['abc'], limit: 20 },
      dbName: 'demo',
      profileFreshness: 600,
      debug: true,
      showAvatars: true,
      showMedia: true,
    });
  });

  it('turns media off only when asked', () => {
    expect(configFromSearchParams(new URLSearchParams('show-media=false')).showMedia).toBe(false);
    expect(configFromSearchParams(new URLSearchParams('show-media=true')).showMedia).toBe(true);
  });

  it('keeps the debug badges off and takes no explicit database name by default', () => {
    const config = configFromSearchParams(new URLSearchParams(''));

    expect(config.debug).toBe(false);
    expect(config.showAvatars).toBe(true);
    expect(config.showMedia).toBe(true);
    expect(config.dbName).toBeUndefined();
    expect(config.profileFreshness).toBeUndefined();
    expect(config.relays).toEqual([]);
    expect(config.filter).toEqual({ kinds: DEFAULT_KINDS, limit: DEFAULT_LIMIT });
  });
});
