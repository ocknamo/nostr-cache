import { describe, expect, it } from 'vitest';
import {
  type ContentPart,
  abbreviateBech32,
  inlineParts,
  mediaAsLinks,
  mediaParts,
  parseContent,
} from './content-parts.ts';

const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';

/** The text a card would show, ignoring how it is split up. */
function textOf(parts: ContentPart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.text;
        case 'link':
          return part.label;
        case 'entity':
          return part.label;
        case 'media':
          return part.url;
      }
    })
    .join('');
}

describe('parseContent', () => {
  it('leaves a plain note as a single text part', () => {
    expect(parseContent('hello there')).toEqual([{ kind: 'text', text: 'hello there' }]);
  });

  it('preserves newlines', () => {
    expect(parseContent('one\n\ntwo')).toEqual([{ kind: 'text', text: 'one\n\ntwo' }]);
  });

  it('links an http(s) URL and keeps the surrounding text', () => {
    expect(parseContent('see https://example.com/a now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'https://example.com/a', label: 'https://example.com/a' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('normalizes the href but shows the URL as written', () => {
    const [part] = parseContent('https://Example.COM/a');
    expect(part).toEqual({
      kind: 'link',
      href: 'https://example.com/a',
      label: 'https://Example.COM/a',
    });
  });

  it.each([
    ['https://example.com/a.', 'https://example.com/a'],
    ['https://example.com/a。', 'https://example.com/a'],
    ['https://example.com/a,', 'https://example.com/a'],
    ['(https://example.com/a)', 'https://example.com/a'],
    ['https://example.com/a?b=1!', 'https://example.com/a?b=1'],
  ])('trims sentence punctuation off %s', (input, expected) => {
    const link = parseContent(input).find((part) => part.kind === 'link');
    expect(link?.label).toBe(expected);
  });

  it('keeps a closing bracket the URL opened itself', () => {
    const link = parseContent('https://en.wikipedia.org/wiki/Bitcoin_(currency)').find(
      (part) => part.kind === 'link'
    );
    expect(link?.label).toBe('https://en.wikipedia.org/wiki/Bitcoin_(currency)');
  });

  it('never linkifies a non-http scheme', () => {
    for (const content of [
      // Linkifying this is exactly what must never happen.
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'ftp://example.com/a',
    ]) {
      expect(parseContent(content)).toEqual([{ kind: 'text', text: content }]);
    }
  });

  it('leaves an implausibly long URL as text', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    expect(parseContent(long)).toEqual([{ kind: 'text', text: long }]);
  });

  it.each([
    ['https://cdn.example.com/a.jpg', 'image'],
    ['https://cdn.example.com/a.PNG', 'image'],
    ['https://cdn.example.com/a.webp?v=2', 'image'],
    ['https://cdn.example.com/a.avif', 'image'],
    ['https://cdn.example.com/a.mp4', 'video'],
    ['https://cdn.example.com/a.webm', 'video'],
    ['https://cdn.example.com/a.ogv', 'video'],
    ['https://cdn.example.com/a.mp3', 'audio'],
    ['https://cdn.example.com/a.ogg', 'audio'],
    ['https://cdn.example.com/a.wav', 'audio'],
    ['https://cdn.example.com/a.m4a', 'audio'],
  ])('classifies %s as %s', (url, media) => {
    expect(parseContent(url)).toEqual([{ kind: 'media', media, url }]);
  });

  it('treats an svg as an ordinary link', () => {
    const url = 'https://cdn.example.com/a.svg';
    expect(parseContent(url)).toEqual([{ kind: 'link', href: url, label: url }]);
  });

  it('ignores an extension that only appears in the query string', () => {
    const url = 'https://example.com/page?next=a.jpg';
    expect(parseContent(url)).toEqual([{ kind: 'link', href: url, label: url }]);
  });

  it('stops rendering attachments past the cap, keeping them as links', () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const parts = parseContent(urls.join(' '));
    expect(parts.filter((part) => part.kind === 'media')).toHaveLength(8);
    expect(parts.filter((part) => part.kind === 'link')).toHaveLength(2);
  });

  it('decodes a nostr: mention', () => {
    const parts = parseContent(`hi nostr:${NPUB}!`);
    expect(parts).toEqual([
      { kind: 'text', text: 'hi ' },
      {
        kind: 'entity',
        entity: { type: 'npub', pubkey: NPUB_HEX },
        raw: `nostr:${NPUB}`,
        label: abbreviateBech32(NPUB),
      },
      { kind: 'text', text: '!' },
    ]);
  });

  it('decodes a bare entity', () => {
    const parts = parseContent(`quoting ${NOTE}`);
    expect(parts[1]).toMatchObject({
      kind: 'entity',
      entity: { type: 'note', id: NOTE_HEX },
      raw: NOTE,
    });
  });

  it('decodes a mention written straight after punctuation', () => {
    // A word boundary is about word characters, not punctuation: `参照:` in
    // front of a `nostr:` URI must not suppress it.
    const parts = parseContent(`参照:nostr:${NPUB}`);
    expect(parts[1]).toMatchObject({ kind: 'entity', raw: `nostr:${NPUB}` });
  });

  it('leaves a corrupted entity as text', () => {
    const corrupted = NPUB.slice(0, -1) + (NPUB.endsWith('q') ? 'p' : 'q');
    expect(parseContent(`nostr:${corrupted}`)).toEqual([
      { kind: 'text', text: `nostr:${corrupted}` },
    ]);
  });

  it('never decodes an nsec', () => {
    const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    expect(parseContent(`nostr:${nsec}`)).toEqual([{ kind: 'text', text: `nostr:${nsec}` }]);
  });

  it('does not pick an entity out of the middle of a word', () => {
    expect(parseContent(`x${NPUB}`)).toEqual([{ kind: 'text', text: `x${NPUB}` }]);
  });

  it('does not pick an entity out of a URL path', () => {
    const url = `https://njump.me/${NPUB}`;
    expect(parseContent(url)).toEqual([{ kind: 'link', href: url, label: url }]);
  });

  it('strips bidi overrides from the text', () => {
    const parts = parseContent('safe‮evil‬ text');
    expect(textOf(parts)).toBe('safeevil text');
  });

  it('emits the tail of a pathological note as one text part', () => {
    const parts = parseContent(`${'https://example.com/a '.repeat(300)}end`);
    // The cap is checked between matches, so the ceiling is MAX_PARTS plus the
    // text/token pair of the match that crossed it, plus the trailing text.
    expect(parts.length).toBeLessThanOrEqual(202);
    expect(parts[parts.length - 1]).toMatchObject({ kind: 'text' });
    expect(textOf(parts).endsWith('end')).toBe(true);
  });

  it('is not disturbed by the previous call leaving the scanner mid-string', () => {
    // The pattern is a shared module-level `g` regex, so a scan that ends with
    // a non-zero `lastIndex` must not change what the next one sees.
    const first = parseContent('a https://example.com/x b');
    expect(parseContent('a https://example.com/x b')).toEqual(first);
  });
});

describe('inlineParts', () => {
  it('lifts an attachment out and closes the gap', () => {
    const parts = parseContent('look https://cdn.example.com/a.jpg at this');
    expect(inlineParts(parts)).toEqual([{ kind: 'text', text: 'look at this' }]);
  });

  it('collapses a run of attachments to a single separator', () => {
    const parts = parseContent('a https://cdn.example.com/1.jpg https://cdn.example.com/2.jpg b');
    expect(inlineParts(parts)).toEqual([{ kind: 'text', text: 'a b' }]);
  });

  it('keeps a paragraph break around a lifted attachment', () => {
    const parts = parseContent('above\n\nhttps://cdn.example.com/a.jpg\n\nbelow');
    expect(inlineParts(parts)).toEqual([{ kind: 'text', text: 'above\n\nbelow' }]);
  });

  it('leaves nothing for a note that is only attachments', () => {
    expect(inlineParts(parseContent('https://cdn.example.com/a.jpg'))).toEqual([]);
    expect(
      inlineParts(parseContent('https://cdn.example.com/a.jpg https://cdn.example.com/b.png'))
    ).toEqual([]);
  });

  it('separates an attachment from an adjacent link', () => {
    const parts = parseContent('https://cdn.example.com/a.jpg https://example.com/x');
    expect(inlineParts(parts)).toEqual([
      { kind: 'link', href: 'https://example.com/x', label: 'https://example.com/x' },
    ]);
  });

  it('keeps whitespace the author typed away from an attachment', () => {
    expect(inlineParts(parseContent('a  b'))).toEqual([{ kind: 'text', text: 'a  b' }]);
  });

  it('trims whitespace at the ends of the run', () => {
    expect(inlineParts(parseContent('  hello  '))).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('keeps links and mentions', () => {
    const parts = parseContent(`a https://example.com/x b nostr:${NPUB}`);
    expect(inlineParts(parts).map((part) => part.kind)).toEqual(['text', 'link', 'text', 'entity']);
  });
});

describe('mediaAsLinks', () => {
  it('turns every attachment back into a link', () => {
    const parts = parseContent('look https://cdn.example.com/a.jpg at this');
    expect(mediaAsLinks(parts)).toEqual([
      { kind: 'text', text: 'look ' },
      {
        kind: 'link',
        href: 'https://cdn.example.com/a.jpg',
        label: 'https://cdn.example.com/a.jpg',
      },
      { kind: 'text', text: ' at this' },
    ]);
  });
});

describe('mediaParts', () => {
  it('returns attachments in source order', () => {
    const parts = parseContent('https://cdn.example.com/a.jpg https://cdn.example.com/b.mp4');
    expect(mediaParts(parts)).toEqual([
      { kind: 'media', media: 'image', url: 'https://cdn.example.com/a.jpg' },
      { kind: 'media', media: 'video', url: 'https://cdn.example.com/b.mp4' },
    ]);
  });

  it('shows a repeated URL once', () => {
    const parts = parseContent('https://cdn.example.com/a.jpg https://cdn.example.com/a.jpg');
    expect(mediaParts(parts)).toHaveLength(1);
  });
});

describe('abbreviateBech32', () => {
  it('keeps the prefix legible', () => {
    expect(abbreviateBech32(NPUB)).toBe('npub10elf…jptg');
  });

  it('leaves a short entity alone', () => {
    expect(abbreviateBech32('npub1qqqq')).toBe('npub1qqqq');
  });
});
