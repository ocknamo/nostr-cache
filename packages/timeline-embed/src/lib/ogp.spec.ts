// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContent } from './content-parts.ts';
import {
  DEFAULT_OGP_PROXY,
  MAX_CACHED_PREVIEWS,
  OGP_TIMEOUT_MS,
  ogpRequestUrl,
  parseOgpHtml,
  previewTarget,
  requestOgp,
  resetOgpCache,
} from './ogp.ts';

const PROXY = 'https://corsproxy.io/?key=abc';

/** Build a page carrying the given meta tags. */
function page(tags: Record<string, string>): string {
  const meta = Object.entries(tags)
    .map(([key, value]) => `<meta property="${key}" content="${value}" />`)
    .join('\n');
  return `<!doctype html><html><head>${meta}</head><body>本文</body></html>`;
}

/**
 * A stand-in for `Response`, so these specs do not depend on which of jsdom's
 * and Node's globals the environment ends up handing them.
 */
function htmlResponse(
  body: string,
  { ok = true, contentType = 'text/html; charset=utf-8' } = {}
): Response {
  return {
    ok,
    headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

describe('previewTarget', () => {
  it('picks the first ordinary link', () => {
    const parts = parseContent('a https://example.com/one then https://example.com/two');

    expect(previewTarget(parts)).toBe('https://example.com/one');
  });

  it('skips media, which is already rendered as an attachment', () => {
    const parts = parseContent('https://cdn.example.com/a.jpg then https://example.com/page');

    expect(previewTarget(parts)).toBe('https://example.com/page');
  });

  it('skips a media URL that spilled past the attachment cap', () => {
    // Past MAX_MEDIA the parser emits an image URL as an ordinary link, and a
    // preview has nothing to say about a .jpg.
    const images = Array.from({ length: 9 }, (_, index) => `https://cdn.example.com/${index}.jpg`);
    const parts = parseContent(`${images.join(' ')} https://example.com/page`);

    expect(parts.some((part) => part.kind === 'link')).toBe(true);
    expect(previewTarget(parts)).toBe('https://example.com/page');
  });

  it('has nothing to preview in a note without links', () => {
    expect(previewTarget(parseContent('hello there'))).toBeUndefined();
    expect(
      previewTarget(
        parseContent('nostr:npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg')
      )
    ).toBeUndefined();
  });
});

describe('ogpRequestUrl', () => {
  it('adds the target as a percent-encoded `url` parameter', () => {
    expect(ogpRequestUrl(DEFAULT_OGP_PROXY, 'https://example.com/a?b=1')).toBe(
      'https://corsproxy.io/?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1'
    );
  });

  it("keeps the proxy's own query string, so an API key on it survives", () => {
    expect(ogpRequestUrl(PROXY, 'https://example.com/a')).toBe(
      'https://corsproxy.io/?key=abc&url=https%3A%2F%2Fexample.com%2Fa'
    );
  });

  it('encodes a space as %20 rather than +', () => {
    expect(ogpRequestUrl(DEFAULT_OGP_PROXY, 'https://example.com/a b')).toBe(
      'https://corsproxy.io/?url=https%3A%2F%2Fexample.com%2Fa%20b'
    );
  });

  it('resolves a relative proxy against the embedding page', () => {
    expect(ogpRequestUrl('/cors', 'https://example.com/a')).toBe(
      `${location.origin}/cors?url=https%3A%2F%2Fexample.com%2Fa`
    );
  });

  it('drops a fragment on the proxy, which would swallow the parameter', () => {
    expect(ogpRequestUrl('https://corsproxy.io/#frag', 'https://example.com/a')).toBe(
      'https://corsproxy.io/?url=https%3A%2F%2Fexample.com%2Fa'
    );
  });

  it('does not double the separator on a proxy written with a trailing ?', () => {
    expect(ogpRequestUrl('https://corsproxy.io/?', 'https://example.com/a')).toBe(
      'https://corsproxy.io/?url=https%3A%2F%2Fexample.com%2Fa'
    );
  });

  it('refuses a proxy that is not http(s)', () => {
    expect(ogpRequestUrl('javascript:alert(1)', 'https://example.com/a')).toBeUndefined();
    expect(ogpRequestUrl('data:text/plain,x', 'https://example.com/a')).toBeUndefined();
  });
});

describe('parseOgpHtml', () => {
  const url = 'https://example.com/a';

  it('reads the og: tags', () => {
    expect(
      parseOgpHtml(
        page({
          'og:title': 'A title',
          'og:description': 'A description',
          'og:image': 'https://cdn.example.com/a.png',
          'og:site_name': 'Example',
        }),
        url
      )
    ).toEqual({
      url,
      title: 'A title',
      description: 'A description',
      image: 'https://cdn.example.com/a.png',
      siteName: 'Example',
    });
  });

  it('falls back to the twitter card and the plain document tags', () => {
    const html = `<!doctype html><html><head>
      <title>Document title</title>
      <meta name="description" content="Plain description" />
      <meta name="twitter:image" content="https://cdn.example.com/t.png" />
      </head><body></body></html>`;

    expect(parseOgpHtml(html, url)).toEqual({
      url,
      title: 'Document title',
      description: 'Plain description',
      image: 'https://cdn.example.com/t.png',
    });
  });

  it('resolves an image path against the page it came from', () => {
    expect(parseOgpHtml(page({ 'og:title': 'A', 'og:image': '/og.png' }), url)?.image).toBe(
      'https://example.com/og.png'
    );
  });

  it('reads the alternate image spellings', () => {
    expect(
      parseOgpHtml(
        page({ 'og:title': 'A', 'og:image:secure_url': 'https://cdn.example.com/s.png' }),
        url
      )?.image
    ).toBe('https://cdn.example.com/s.png');
    expect(
      parseOgpHtml(page({ 'og:title': 'A', 'og:image:url': 'https://cdn.example.com/u.png' }), url)
        ?.image
    ).toBe('https://cdn.example.com/u.png');
    const twitter = `<!doctype html><html><head>
      <meta property="og:title" content="A" />
      <meta name="twitter:image:src" content="https://cdn.example.com/t.png" />
      <meta name="application-name" content="Example" />
      </head></html>`;
    expect(parseOgpHtml(twitter, url)?.image).toBe('https://cdn.example.com/t.png');
    expect(parseOgpHtml(twitter, url)?.siteName).toBe('Example');
  });

  it('falls through an empty tag to the next spelling of the same field', () => {
    const html = `<!doctype html><html><head>
      <title>Document title</title>
      <meta property="og:title" content="" />
      <meta property="og:image" content="  " />
      <meta name="twitter:image" content="https://cdn.example.com/t.png" />
      </head></html>`;

    expect(parseOgpHtml(html, url)).toEqual({
      url,
      title: 'Document title',
      image: 'https://cdn.example.com/t.png',
    });
  });

  it('keeps the first of a repeated tag', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="First" />
      <meta property="og:title" content="Second" />
      </head></html>`;

    expect(parseOgpHtml(html, url)?.title).toBe('First');
  });

  it('links to the URL that was asked about, not the one the page names', () => {
    const data = parseOgpHtml(
      page({ 'og:title': 'A title', 'og:url': 'https://evil.example/' }),
      url
    );

    expect(data?.url).toBe(url);
  });

  it('renders nothing without a title', () => {
    expect(
      parseOgpHtml(page({ 'og:image': 'https://cdn.example.com/a.png' }), url)
    ).toBeUndefined();
    expect(parseOgpHtml(page({ 'og:title': '   ' }), url)).toBeUndefined();
  });

  it('renders nothing for a body that is not a page', () => {
    expect(parseOgpHtml('', url)).toBeUndefined();
    expect(parseOgpHtml('{"title":"A title"}', url)).toBeUndefined();
  });

  it('drops an image the browser must not be handed', () => {
    expect(
      parseOgpHtml(page({ 'og:title': 'A', 'og:image': 'javascript:alert(1)' }), url)?.image
    ).toBeUndefined();
    expect(
      parseOgpHtml(page({ 'og:title': 'A', 'og:image': 'data:image/png;base64,AAAA' }), url)?.image
    ).toBeUndefined();
  });

  it('keeps a long generated image URL, past the avatar-sized ceiling', () => {
    // Preview images are routinely generated per page, with the title and a
    // signature in the query string — far longer than any avatar URL.
    const long = `https://cdn.example.com/og.png?t=${'x'.repeat(1900)}`;
    expect(long.length).toBeGreaterThan(512);
    expect(long.length).toBeLessThanOrEqual(2048);

    expect(parseOgpHtml(page({ 'og:title': 'A', 'og:image': long }), url)?.image).toBe(long);
  });

  it('drops an image URL past 2048 characters, keeping the rest of the card', () => {
    const tooLong = `https://cdn.example.com/og.png?t=${'x'.repeat(2100)}`;
    const data = parseOgpHtml(page({ 'og:title': 'A title', 'og:image': tooLong }), url);

    expect(data?.image).toBeUndefined();
    expect(data?.title).toBe('A title');
  });

  it('strips the control characters that would let a title reshape the card', () => {
    expect(parseOgpHtml(page({ 'og:title': 'safe‮title here' }), url)?.title).toBe('safetitle here');
  });

  it('clips a title and a description that went long', () => {
    const data = parseOgpHtml(
      page({ 'og:title': 'あ'.repeat(300), 'og:description': 'い'.repeat(600) }),
      url
    );

    expect(data?.title).toHaveLength(201);
    expect(data?.title.endsWith('…')).toBe(true);
    expect(data?.description).toHaveLength(401);
  });

  it('rejects a field long enough to be a payload rather than a title', () => {
    expect(parseOgpHtml(page({ 'og:title': 'a'.repeat(5000) }), url)).toBeUndefined();
  });
});

describe('requestOgp', () => {
  beforeEach(() => {
    resetOgpCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches the page through the proxy and returns the preview', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page({ 'og:title': 'A title' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toEqual({
      url: 'https://example.com/a',
      title: 'A title',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://corsproxy.io/?key=abc&url=https%3A%2F%2Fexample.com%2Fa',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    );
  });

  it('sends a simple request, which needs no preflight', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page({ 'og:title': 'A title' })));
    vi.stubGlobal('fetch', fetchMock);

    await requestOgp(PROXY, 'https://example.com/a');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ Accept: 'text/html' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a page in the encoding it declares', async () => {
    // Shift_JIS is still out there, and `Response.text()` would decode it as
    // UTF-8 and leave the title as mojibake.
    const bytes = Uint8Array.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // 「テスト」 in Shift_JIS
    const html = `<!doctype html><html><head><meta charset="shift_jis"><meta property="og:title" content="`;
    const body = new Uint8Array([
      ...new TextEncoder().encode(html),
      ...bytes,
      ...new TextEncoder().encode('"></head></html>'),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => body.buffer,
      }))
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toMatchObject({
      title: 'テスト',
    });
  });

  it('reads the encoding from the response header too', async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta property="og:title" content="'),
      0x83,
      0x65,
      0x83,
      0x58,
      0x83,
      0x67,
      ...new TextEncoder().encode('"></head></html>'),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'text/html; charset=Shift_JIS' },
        arrayBuffer: async () => body.buffer,
      }))
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toMatchObject({
      title: 'テスト',
    });
  });

  it('falls back to UTF-8 when the page declares an encoding that is not one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse(page({ 'og:title': '見出し' }), { contentType: 'text/html; charset=nonsense' })
      )
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toMatchObject({
      title: '見出し',
    });
  });

  it('stops reading at the byte ceiling, and stops the download with it', async () => {
    // A page whose metadata sits past the ceiling: the card is worth less than
    // the bandwidth it would take to reach it.
    const padding = new TextEncoder().encode(
      `<!doctype html><html><head>${'<!--x-->'.repeat(40_000)}`
    );
    const tail = new TextEncoder().encode(
      '<meta property="og:title" content="Too far in" /></head></html>'
    );
    expect(padding.length).toBeGreaterThan(256 * 1024);

    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => {
            const chunks = [padding, tail];
            let index = 0;
            return {
              read: async () =>
                index < chunks.length
                  ? { done: false, value: chunks[index++] }
                  : { done: true, value: undefined },
              cancel: async () => {
                cancelled = true;
              },
            };
          },
        },
      }))
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it('renders nothing where there is no DOM to parse with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(page({ 'og:title': 'A title' })))
    );
    vi.stubGlobal('DOMParser', undefined);

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toBeUndefined();
  });

  it('asks once per URL, however many cards want it', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page({ 'og:title': 'A title' })));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      requestOgp(PROXY, 'https://example.com/a'),
      requestOgp(PROXY, 'https://example.com/a'),
    ]);
    await requestOgp(PROXY, 'https://example.com/a');

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure, so a dead proxy costs one request', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('', { ok: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toBeUndefined();
    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer that is not a page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse('{"title":"A title"}', { contentType: 'application/json; charset=utf-8' })
      )
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toBeUndefined();
  });

  it('reads the metadata out of a page that goes on long past its head', async () => {
    const head = page({ 'og:title': 'A title' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(`${head}${'<p>x</p>'.repeat(60_000)}`))
    );

    await expect(requestOgp(PROXY, 'https://example.com/a')).resolves.toMatchObject({
      title: 'A title',
    });
  });

  it('gives up on a proxy that never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_request: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );

    const pending = requestOgp(PROXY, 'https://example.com/a');
    await vi.advanceTimersByTimeAsync(OGP_TIMEOUT_MS);

    await expect(pending).resolves.toBeUndefined();
  });

  it('drops the oldest preview once the page has collected too many', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page({ 'og:title': 'A title' })));
    vi.stubGlobal('fetch', fetchMock);

    const first = 'https://example.com/0';
    await requestOgp(PROXY, first);
    for (let index = 1; index <= MAX_CACHED_PREVIEWS; index++) {
      await requestOgp(PROXY, `https://example.com/${index}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CACHED_PREVIEWS + 1);

    // The first URL has been evicted, so asking again costs another request.
    await requestOgp(PROXY, first);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CACHED_PREVIEWS + 2);
  });

  it('never asks when the proxy is unusable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requestOgp('javascript:alert(1)', 'https://example.com/a')
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
