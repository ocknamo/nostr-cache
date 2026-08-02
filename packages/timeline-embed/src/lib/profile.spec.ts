import { describe, expect, it } from 'vitest';
import { authorHandle, authorName, parseProfileContent, shortPubkey } from './profile.ts';

const PUBKEY = 'pk0000000000000000000000000000000000000000000000000000000000000';

describe('parseProfileContent', () => {
  it('reads the fields the timeline renders', () => {
    const profile = parseProfileContent(
      JSON.stringify({
        name: 'takeshi',
        display_name: 'たけし',
        picture: 'https://example.com/a.png',
        nip05: 'takeshi@example.com',
        about: 'ignored',
      })
    );

    expect(profile).toEqual({
      name: 'takeshi',
      displayName: 'たけし',
      picture: 'https://example.com/a.png',
      nip05: 'takeshi@example.com',
    });
  });

  it('accepts the camelCase spelling of display_name', () => {
    expect(parseProfileContent(JSON.stringify({ displayName: 'たけし' }))?.displayName).toBe(
      'たけし'
    );
  });

  it('returns undefined for content that is not a JSON object', () => {
    expect(parseProfileContent('not json')).toBeUndefined();
    expect(parseProfileContent('"a string"')).toBeUndefined();
    expect(parseProfileContent('[1, 2]')).toBeUndefined();
    expect(parseProfileContent('null')).toBeUndefined();
  });

  it('returns undefined when no renderable field survives', () => {
    expect(parseProfileContent(JSON.stringify({ about: 'hello', website: 'x' }))).toBeUndefined();
  });

  it('drops fields that are not strings', () => {
    const profile = parseProfileContent(
      JSON.stringify({ name: 42, display_name: { a: 1 }, picture: ['x'], nip05: 'n@example.com' })
    );

    expect(profile).toEqual({ nip05: 'n@example.com' });
  });

  it('strips control characters and bidi overrides from names', () => {
    const profile = parseProfileContent(
      JSON.stringify({ name: 'ali\u000Ace', display_name: '\u202Eたけし\u202C' })
    );

    // A newline would break the single-line header; a bidi override could make
    // the name read as something other than what it is.
    expect(profile).toEqual({ name: 'alice', displayName: 'たけし' });
  });

  it('drops a name that is nothing but control characters', () => {
    expect(parseProfileContent(JSON.stringify({ name: '\u0000\u0001' }))).toBeUndefined();
  });

  it('returns the parsed form of a picture URL, not the raw string', () => {
    const profile = parseProfileContent(
      JSON.stringify({ name: 'n', picture: 'https://example.com/a\u0009b.png' })
    );

    expect(profile?.picture).toBe('https://example.com/ab.png');
  });

  it('drops names longer than the render cap', () => {
    const profile = parseProfileContent(
      JSON.stringify({ name: 'a'.repeat(129), display_name: 'b'.repeat(128) })
    );

    expect(profile).toEqual({ displayName: 'b'.repeat(128) });
  });

  it('rejects a picture URL that is not http(s)', () => {
    for (const picture of [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(parseProfileContent(JSON.stringify({ name: 'n', picture }))).toEqual({ name: 'n' });
    }
  });

  it('rejects a picture URL longer than the cap', () => {
    const picture = `https://example.com/${'a'.repeat(512)}`;

    expect(parseProfileContent(JSON.stringify({ name: 'n', picture }))).toEqual({ name: 'n' });
  });
});

describe('shortPubkey', () => {
  it('abbreviates a full-length pubkey', () => {
    expect(shortPubkey(PUBKEY)).toBe('pk000000…00000000');
  });

  it('leaves an already short value alone', () => {
    expect(shortPubkey('abc')).toBe('abc');
  });
});

describe('authorName', () => {
  it('prefers the display name', () => {
    expect(authorName(PUBKEY, { displayName: 'たけし', name: 'takeshi' })).toBe('たけし');
  });

  it('falls back to the handle, then to the shortened pubkey', () => {
    expect(authorName(PUBKEY, { name: 'takeshi' })).toBe('takeshi');
    expect(authorName(PUBKEY, {})).toBe('pk000000…00000000');
    expect(authorName(PUBKEY)).toBe('pk000000…00000000');
  });
});

describe('authorHandle', () => {
  it('returns the handle when it adds information', () => {
    expect(authorHandle(PUBKEY, { displayName: 'たけし', name: 'takeshi' })).toBe('takeshi');
  });

  it('is suppressed when it would repeat the displayed name', () => {
    expect(authorHandle(PUBKEY, { name: 'takeshi' })).toBeUndefined();
  });

  it('is undefined without a profile', () => {
    expect(authorHandle(PUBKEY)).toBeUndefined();
  });
});
