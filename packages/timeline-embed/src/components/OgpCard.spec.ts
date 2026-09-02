// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOgpCache } from '../lib/ogp.ts';
import OgpCard from './OgpCard.svelte';

const PROXY = 'https://corsproxy.io/';
const URL_A = 'https://example.com/a';

/** A page carrying the given `og:` tags. */
function page(tags: Record<string, string>): string {
  const meta = Object.entries(tags)
    .map(([key, value]) => `<meta property="og:${key}" content="${value}" />`)
    .join('');
  return `<!doctype html><html><head>${meta}</head><body></body></html>`;
}

function htmlResponse(body: string): Response {
  return {
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

/** Answer every request with the same page. */
function stubProxy(tags: Record<string, string>) {
  const fetchMock = vi.fn(async () => htmlResponse(page(tags)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('OgpCard', () => {
  beforeEach(() => {
    resetOgpCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the preview once the page arrives', async () => {
    stubProxy({
      title: 'A title',
      description: 'A description',
      site_name: 'Example',
      image: 'https://cdn.example.com/a.png',
    });
    const { container } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });

    expect(await screen.findByText('A title')).toBeInTheDocument();
    expect(screen.getByText('A description')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/a.png');
  });

  it('opens the link the author wrote, without a window or a referrer', async () => {
    stubProxy({ title: 'A title' });
    render(OgpCard, { props: { proxy: PROXY, url: URL_A } });

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', URL_A);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('does not tell the image host which page the widget is embedded in', async () => {
    stubProxy({ title: 'A title', image: 'https://cdn.example.com/a.png' });
    const { container } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });

    await screen.findByText('A title');
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    // The title beside it is the link's accessible name.
    expect(image).toHaveAttribute('alt', '');
  });

  it('keeps the card when the thumbnail fails to load', async () => {
    stubProxy({ title: 'A title', image: 'https://cdn.example.com/gone.png' });
    const { container } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });

    await screen.findByText('A title');
    await fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A title')).toBeInTheDocument();
  });

  it('serves the thumbnail through the image proxy, falling back to its host', async () => {
    stubProxy({ title: 'A title', image: 'https://cdn.example.com/a.png' });
    const { container } = render(OgpCard, {
      props: { proxy: PROXY, url: URL_A, imageProxy: 'https://optimizer.example/image' },
    });

    await screen.findByText('A title');
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://optimizer.example/image/width=600,quality=60,format=webp/https://cdn.example.com/a.png'
    );

    await fireEvent.error(container.querySelector('img') as HTMLImageElement);

    await expect
      .poll(() => container.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/a.png');
  });

  it('renders nothing when the page has no title to show', async () => {
    stubProxy({ description: 'A description' });
    const { container } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });

    // One microtask past the request, which is all a rendered card would need.
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('a')).toBeNull();
  });

  it('renders nothing for a link that is not http(s)', async () => {
    const fetchMock = stubProxy({ title: 'A title' });
    const { container } = render(OgpCard, {
      props: { proxy: PROXY, url: 'javascript:alert(1)' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('a')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a late answer for the previous link blank the card it moved to', async () => {
    // The reuse case in `<nostr-post>`: the first lookup is still in flight when
    // the card moves on, and resolves after the second one has already rendered.
    const pending = new Map<string, (tags: Record<string, string>) => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (request: string) =>
          new Promise<Response>((resolve) => {
            pending.set(request.includes('%2Fa') ? 'a' : 'b', (tags) =>
              resolve(htmlResponse(page(tags)))
            );
          })
      )
    );

    const { rerender } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });
    await rerender({ proxy: PROXY, url: 'https://example.com/b' });

    pending.get('b')?.({ title: 'Second' });
    expect(await screen.findByText('Second')).toBeInTheDocument();

    pending.get('a')?.({ title: 'First' });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });

  it('drops the previous preview when the card moves to another link', async () => {
    const fetchMock = vi.fn(async (request: string) =>
      htmlResponse(page({ title: request.includes('%2Fa') ? 'First' : 'Second' }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(OgpCard, { props: { proxy: PROXY, url: URL_A } });
    expect(await screen.findByText('First')).toBeInTheDocument();

    await rerender({ proxy: PROXY, url: 'https://example.com/b' });

    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });
});
