// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOgpCache } from '../lib/ogp.ts';
import OgpCard from './OgpCard.svelte';

const ENDPOINT = 'https://ogp.example/api';
const URL_A = 'https://example.com/a';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Answer every request with the same metadata. */
function stubEndpoint(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body));
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

  it('renders the preview once the endpoint answers', async () => {
    stubEndpoint({
      title: 'A title',
      description: 'A description',
      siteName: 'Example',
      image: 'https://cdn.example.com/a.png',
    });
    const { container } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });

    expect(await screen.findByText('A title')).toBeInTheDocument();
    expect(screen.getByText('A description')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/a.png');
  });

  it('opens the link the author wrote, without a window or a referrer', async () => {
    stubEndpoint({ title: 'A title' });
    render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', URL_A);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('does not tell the image host which page the widget is embedded in', async () => {
    stubEndpoint({ title: 'A title', image: 'https://cdn.example.com/a.png' });
    const { container } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });

    await screen.findByText('A title');
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    // The title beside it is the link's accessible name.
    expect(image).toHaveAttribute('alt', '');
  });

  it('keeps the card when the thumbnail fails to load', async () => {
    stubEndpoint({ title: 'A title', image: 'https://cdn.example.com/gone.png' });
    const { container } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });

    await screen.findByText('A title');
    await fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A title')).toBeInTheDocument();
  });

  it('renders nothing when the endpoint has no title to show', async () => {
    stubEndpoint({ description: 'A description' });
    const { container } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });

    // One microtask past the request, which is all a rendered card would need.
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('a')).toBeNull();
  });

  it('renders nothing for a link that is not http(s)', async () => {
    const fetchMock = stubEndpoint({ title: 'A title' });
    const { container } = render(OgpCard, {
      props: { endpoint: ENDPOINT, url: 'javascript:alert(1)' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('a')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a late answer for the previous link blank the card it moved to', async () => {
    // The reuse case in `<nostr-post>`: the first lookup is still in flight when
    // the card moves on, and resolves after the second one has already rendered.
    const pending = new Map<string, (body: unknown) => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (request: string) =>
          new Promise<Response>((resolve) => {
            pending.set(request.includes('%2Fa') ? 'a' : 'b', (body) =>
              resolve(jsonResponse(body))
            );
          })
      )
    );

    const { rerender } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });
    await rerender({ endpoint: ENDPOINT, url: 'https://example.com/b' });

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
      jsonResponse({ title: request.includes('%2Fa') ? 'First' : 'Second' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(OgpCard, { props: { endpoint: ENDPOINT, url: URL_A } });
    expect(await screen.findByText('First')).toBeInTheDocument();

    await rerender({ endpoint: ENDPOINT, url: 'https://example.com/b' });

    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });
});
