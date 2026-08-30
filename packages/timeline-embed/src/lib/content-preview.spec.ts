import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { PREVIEW_MAX_LENGTH, eventPreview, notePreview } from './content-preview.ts';
import type { Profile } from './profile.ts';

const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';

/**
 * Code units left without their partner — `String.prototype.isWellFormed` under
 * a `lib` that does not have it yet. Iteration is by code point, so a valid
 * pair comes out as one two-unit string and only a broken one is length 1.
 */
function loneSurrogates(value: string): string[] {
  return [...value].filter(
    (char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff
  );
}

describe('notePreview', () => {
  it('collapses every run of whitespace into one space', () => {
    // The regression guard for the order of the two steps: stripping the
    // control characters first would leave "一行目二行目".
    expect(notePreview('一行目\n\n二行目\t三行目　四行目')).toBe('一行目 二行目 三行目 四行目');
  });

  it('trims the ends', () => {
    expect(notePreview('  \n おはよう \n ')).toBe('おはよう');
  });

  it('drops control characters and bidi overrides', () => {
    expect(notePreview('a\u0000b\u202Ec\u009Fd')).toBe('abcd');
  });

  it('names an attachment rather than showing its URL', () => {
    expect(notePreview('見て https://example.com/cat.jpg')).toBe('見て [画像]');
    expect(notePreview('https://example.com/clip.mp4')).toBe('[動画]');
    expect(notePreview('https://example.com/song.mp3')).toBe('[音声]');
  });

  it('reduces a plain link to its host', () => {
    expect(notePreview('詳細は https://example.com/a/very/long/path?q=1 まで')).toBe(
      '詳細は example.com まで'
    );
  });

  it('resolves a mention against the profiles it was given', () => {
    const profiles = new Map<string, Profile>([[NPUB_HEX, { displayName: 'アリス' }]]);

    expect(notePreview(`nostr:${NPUB} おはよう`, { profiles })).toBe('@アリス おはよう');
  });

  it('abbreviates an entity it cannot name', () => {
    expect(notePreview(`nostr:${NPUB}`)).toBe('npub10elf…jptg');
    expect(notePreview(`nostr:${NOTE}`, { profiles: new Map() })).toBe('note1tszz…elrl');
  });

  it('truncates by code point, marking the cut', () => {
    const result = notePreview('あ'.repeat(200));

    expect(result).toBe(`${'あ'.repeat(PREVIEW_MAX_LENGTH)}…`);
  });

  it('never cuts a surrogate pair in half', () => {
    const result = notePreview('🐈'.repeat(200), { maxLength: 5 });

    expect(result).toBe('🐈🐈🐈🐈🐈…');
    expect(result).not.toContain('�');
    expect([...result]).toHaveLength(6);
  });

  it('never cuts a surrogate pair at the source limit either', () => {
    // Attachments are what make this reachable: eight very long URLs spend the
    // 2000-character source budget while collapsing to 4 characters each, so
    // the emoji straddling that boundary survives into an output far short of
    // `PREVIEW_MAX_LENGTH` — where the cap above would otherwise have hidden it.
    const attachments = `https://example.com/${'a'.repeat(215)}.jpg `.repeat(8);
    const body = `${attachments}${'x'.repeat(2000 - attachments.length - 1)}🐈`;
    // The naive cut really does land inside the emoji, so this is not testing
    // an input that was harmless to begin with.
    expect(loneSurrogates(body.slice(0, 2000))).toHaveLength(1);

    const result = notePreview(body);

    expect(result.length).toBeLessThan(PREVIEW_MAX_LENGTH);
    expect(loneSurrogates(result)).toHaveLength(0);
  });

  it('leaves a body that already fits alone', () => {
    expect(notePreview('短い', { maxLength: 5 })).toBe('短い');
  });

  it('is empty for a body with nothing in it', () => {
    expect(notePreview('')).toBe('');
    expect(notePreview('   \n  ')).toBe('');
  });
});

describe('eventPreview', () => {
  it('previews an ordinary note', () => {
    expect(eventPreview(makeEvent({ content: 'おはよう\nございます' }))).toBe(
      'おはよう ございます'
    );
  });

  it('is empty for a repost, whose content is a serialized event', () => {
    const reposted = JSON.stringify(makeEvent({ content: 'もとの投稿' }));

    expect(eventPreview(makeEvent({ kind: 6, content: reposted }))).toBe('');
  });

  it('is empty for an encrypted message, whose content is ciphertext', () => {
    expect(eventPreview(makeEvent({ kind: 4, content: 'AbC123==?iv=xyz==' }))).toBe('');
  });

  it('previews a reaction as the glyph its card draws, not as `+`', () => {
    expect(eventPreview(makeEvent({ kind: 7, content: '+' }))).toBe('⭐');
    expect(eventPreview(makeEvent({ kind: 7, content: '🔥' }))).toBe('🔥');
  });
});
