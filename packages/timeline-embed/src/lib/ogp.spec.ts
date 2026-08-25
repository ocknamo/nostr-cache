// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContent } from './content-parts.ts';
import {
  OGP_TIMEOUT_MS,
  ogpRequestUrl,
  parseOgpResponse,
  previewTarget,
  requestOgp,
  resetOgpCache,
} from './ogp.ts';

const ENDPOINT = 'https://ogp.example/api';

/**
 * A stand-in for `Response`, so these specs do not depend on which of jsdom's
 * and Node's globals the environment ends up handing them.
 */
function jsonResponse(
  body: unknown,
  { ok = true, contentType = 'application/json' } = {}
): Response {
  return {
    ok,
    headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
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
  it('adds the target as a `url` parameter', () => {
    expect(ogpRequestUrl(ENDPOINT, 'https://example.com/a?b=1')).toBe(
      'https://ogp.example/api?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1'
    );
  });

  it("keeps the endpoint's own query string", () => {
    const request = ogpRequestUrl('https://ogp.example/api?key=abc', 'https://example.com/a');

    expect(new URL(request as string).searchParams.get('key')).toBe('abc');
    expect(new URL(request as string).searchParams.get('url')).toBe('https://example.com/a');
  });

  it('substitutes a {url} placeholder, percent-encoded', () => {
    expect(ogpRequestUrl('https://ogp.example/p/{url}', 'https://example.com/a?b=1')).toBe(
      'https://ogp.example/p/https%3A%2F%2Fexample.com%2Fa%3Fb%3D1'
    );
  });

  it('resolves a relative endpoint against the embedding page', () => {
    expect(ogpRequestUrl('/ogp', 'https://example.com/a')).toBe(
      `${location.origin}/ogp?url=https%3A%2F%2Fexample.com%2Fa`
    );
  });

  it('refuses an endpoint that is not http(s)', () => {
    expect(ogpRequestUrl('javascript:alert(1)', 'https://example.com/a')).toBeUndefined();
    expect(ogpRequestUrl('data:text/plain,x', 'https://example.com/a')).toBeUndefined();
  });
});

describe('parseOgpResponse', () => {
  const url = 'https://example.com/a';

  it('reads the plain field names', () => {
    expect(
      parseOgpResponse(
        {
          title: 'A title',
          description: 'A description',
          image: 'https://cdn.example.com/a.png',
          siteName: 'Example',
        },
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

  it('reads the og: spellings too', () => {
    expect(
      parseOgpResponse(
        { 'og:title': 'A title', 'og:description': 'D', 'og:site_name': 'Example' },
        url
      )
    ).toEqual({ url, title: 'A title', description: 'D', siteName: 'Example' });
  });

  it('falls through to the other spelling when a field is spelled null', () => {
    expect(parseOgpResponse({ title: null, 'og:title': 'A title' }, url)?.title).toBe('A title');
  });

  it('links to the URL that was asked about, not the one the response names', () => {
    const data = parseOgpResponse({ title: 'A title', url: 'https://evil.example/' }, url);

    expect(data?.url).toBe(url);
  });

  it('renders nothing without a title', () => {
    expect(
      parseOgpResponse({ description: 'D', image: 'https://cdn.example.com/a.png' }, url)
    ).toBeUndefined();
    expect(parseOgpResponse({ title: '   ' }, url)).toBeUndefined();
  });

  it('rejects a payload that is not an object', () => {
    expect(parseOgpResponse([{ title: 'A' }], url)).toBeUndefined();
    expect(parseOgpResponse('A title', url)).toBeUndefined();
    expect(parseOgpResponse(null, url)).toBeUndefined();
  });

  it('drops an image the browser must not be handed', () => {
    expect(
      parseOgpResponse({ title: 'A', image: 'javascript:alert(1)' }, url)?.image
    ).toBeUndefined();
    expect(
      parseOgpResponse({ title: 'A', image: 'data:image/png;base64,AAAA' }, url)?.image
    ).toBeUndefined();
    expect(
      parseOgpResponse({ title: 'A', image: { url: 'https://x/a.png' } }, url)?.image
    ).toBeUndefined();
  });

  it('strips the control characters that would let a title reshape the card', () => {
    expect(parseOgpResponse({ title: 'safe‮title\nhere' }, url)?.title).toBe('safetitlehere');
  });

  it('clips a title and a description that went long', () => {
    const data = parseOgpResponse({ title: 'あ'.repeat(300), description: 'い'.repeat(600) }, url);

    expect(data?.title).toHaveLength(201);
    expect(data?.title.endsWith('…')).toBe(true);
    expect(data?.description).toHaveLength(401);
  });

  it('rejects a field long enough to be a payload rather than a title', () => {
    expect(parseOgpResponse({ title: 'a'.repeat(5000) }, url)).toBeUndefined();
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

  it('asks the endpoint and returns the preview', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ title: 'A title' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toEqual({
      url: 'https://example.com/a',
      title: 'A title',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ogp.example/api?url=https%3A%2F%2Fexample.com%2Fa',
      expect.objectContaining({ credentials: 'omit' })
    );
  });

  it('asks once per URL, however many cards want it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ title: 'A title' }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      requestOgp(ENDPOINT, 'https://example.com/a'),
      requestOgp(ENDPOINT, 'https://example.com/a'),
    ]);
    await requestOgp(ENDPOINT, 'https://example.com/a');

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure, so a dead endpoint costs one request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { ok: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toBeUndefined();
    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<html>…</html>', { contentType: 'text/html' }))
    );

    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toBeUndefined();
  });

  it('ignores a body too large to be metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(JSON.stringify({ title: 'x'.repeat(100_000) })))
    );

    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toBeUndefined();
  });

  it('ignores malformed JSON rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('{not json'))
    );

    await expect(requestOgp(ENDPOINT, 'https://example.com/a')).resolves.toBeUndefined();
  });

  it('gives up on an endpoint that never answers', async () => {
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

    const pending = requestOgp(ENDPOINT, 'https://example.com/a');
    await vi.advanceTimersByTimeAsync(OGP_TIMEOUT_MS);

    await expect(pending).resolves.toBeUndefined();
  });

  it('never asks when the endpoint is unusable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requestOgp('javascript:alert(1)', 'https://example.com/a')
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
