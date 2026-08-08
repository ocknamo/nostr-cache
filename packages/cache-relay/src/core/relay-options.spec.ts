/** Tests for relay option defaulting. */

import {
  DEFAULT_MAX_EVENTS,
  normalizeCachePriority,
  normalizeFreshnessWindows,
  resolveRelayOptions,
} from './relay-options.js';

// NIP-19 公式テストベクタ
const OFFICIAL_NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const OFFICIAL_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

describe('resolveRelayOptions', () => {
  it('applies defaults when nothing is provided', () => {
    const resolved = resolveRelayOptions({});
    expect(resolved.validateEventsType).toBe('IMMEDIATELY');
    expect(resolved.maxSubscriptions).toBe(20);
    expect(resolved.maxEventsPerRequest).toBe(DEFAULT_MAX_EVENTS);
  });

  it('lets caller options override the defaults', () => {
    const resolved = resolveRelayOptions({
      validateEventsType: 'LAZY',
      maxSubscriptions: 5,
      maxEventsPerRequest: 10,
    });
    expect(resolved.validateEventsType).toBe('LAZY');
    expect(resolved.maxSubscriptions).toBe(5);
    expect(resolved.maxEventsPerRequest).toBe(10);
  });

  it('does not let an explicit undefined maxEventsPerRequest clobber the default', () => {
    const resolved = resolveRelayOptions({ maxEventsPerRequest: undefined });
    expect(resolved.maxEventsPerRequest).toBe(DEFAULT_MAX_EVENTS);
  });

  it('passes through unrelated options untouched', () => {
    const resolved = resolveRelayOptions({ ttl: 120, upstreamRelays: ['wss://x'] });
    expect(resolved.ttl).toBe(120);
    expect(resolved.upstreamRelays).toEqual(['wss://x']);
  });

  it('returns a new object without mutating the input', () => {
    const input = { maxSubscriptions: 3 };
    const resolved = resolveRelayOptions(input);
    expect(resolved).not.toBe(input);
    expect(input).toEqual({ maxSubscriptions: 3 });
  });

  it('normalizes cachePriority pubkeys (npub decoded to hex)', () => {
    const resolved = resolveRelayOptions({
      cachePriority: { pubkeys: [OFFICIAL_NPUB], kinds: [0] },
    });
    expect(resolved.cachePriority).toEqual({ pubkeys: [OFFICIAL_HEX], kinds: [0] });
  });

  it('throws on an invalid cachePriority pubkey', () => {
    expect(() => resolveRelayOptions({ cachePriority: { pubkeys: ['not-a-key'] } })).toThrow(
      /not-a-key/
    );
  });
});

describe('normalizeCachePriority', () => {
  it('returns undefined for absent or empty config', () => {
    expect(normalizeCachePriority(undefined)).toBeUndefined();
    expect(normalizeCachePriority({})).toBeUndefined();
    expect(normalizeCachePriority({ pubkeys: [], kinds: [] })).toBeUndefined();
  });

  it('decodes npub and lowercases hex pubkeys', () => {
    const normalized = normalizeCachePriority({
      pubkeys: [OFFICIAL_NPUB, OFFICIAL_HEX.toUpperCase()],
    });
    // npub と大文字 hex は同一キーに正規化され、重複排除される
    expect(normalized).toEqual({ pubkeys: [OFFICIAL_HEX], kinds: [] });
  });

  it('deduplicates kinds', () => {
    expect(normalizeCachePriority({ kinds: [0, 3, 0] })).toEqual({ pubkeys: [], kinds: [0, 3] });
  });

  it('throws on an invalid pubkey naming the input', () => {
    expect(() => normalizeCachePriority({ pubkeys: ['npub1invalid'] })).toThrow(/npub1invalid/);
  });

  it('throws on non-integer or out-of-range kinds', () => {
    expect(() => normalizeCachePriority({ kinds: [1.5] })).toThrow(/1\.5/);
    expect(() => normalizeCachePriority({ kinds: [-1] })).toThrow(/-1/);
    expect(() => normalizeCachePriority({ kinds: [65536] })).toThrow(/65536/);
  });
});

describe('normalizeFreshnessWindows', () => {
  it('returns undefined for absent or empty config', () => {
    expect(normalizeFreshnessWindows(undefined)).toBeUndefined();
    expect(normalizeFreshnessWindows({})).toBeUndefined();
  });

  it('converts the record into a kind → seconds map', () => {
    const windows = normalizeFreshnessWindows({ 0: 3600, 3: 600, 10002: 60 });
    expect(windows).toEqual(
      new Map([
        [0, 3600],
        [3, 600],
        [10002, 60],
      ])
    );
  });

  it('throws on a non-replaceable kind naming it', () => {
    // 通常 kind は結果集合が非有界で、窓を尊重できない
    expect(() => normalizeFreshnessWindows({ 1: 3600 })).toThrow(/kind 1/);
    // addressable は d タグが座標に入るため今回対象外
    expect(() => normalizeFreshnessWindows({ 30023: 3600 })).toThrow(/kind 30023/);
    expect(() => normalizeFreshnessWindows({ 20000: 3600 })).toThrow(/kind 20000/);
  });

  it('throws on an out-of-range kind', () => {
    expect(() => normalizeFreshnessWindows({ 65536: 3600 })).toThrow(/65536/);
    expect(() => normalizeFreshnessWindows({ '-1': 3600 })).toThrow(/-1/);
  });

  it('throws on a non-positive or non-finite window', () => {
    expect(() => normalizeFreshnessWindows({ 0: 0 })).toThrow(/kind 0/);
    expect(() => normalizeFreshnessWindows({ 0: -1 })).toThrow(/kind 0/);
    expect(() => normalizeFreshnessWindows({ 0: Number.NaN })).toThrow(/kind 0/);
    expect(() => normalizeFreshnessWindows({ 0: Number.POSITIVE_INFINITY })).toThrow(/kind 0/);
  });

  it('is not applied by resolveRelayOptions (the relay normalizes it itself)', () => {
    // 公開オプション型は素の Record のまま通す
    const resolved = resolveRelayOptions({ upstreamFreshness: { 0: 3600 } });
    expect(resolved.upstreamFreshness).toEqual({ 0: 3600 });
  });
});
