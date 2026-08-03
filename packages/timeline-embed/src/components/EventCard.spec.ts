// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import EventCard from './EventCard.svelte';

describe('EventCard', () => {
  it('renders the content and a shortened pubkey that keeps the full one on hover', () => {
    const event = makeEvent({ content: 'hello there' });
    render(EventCard, { props: { event } });

    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByTitle(event.pubkey)).toHaveTextContent('pk000000…00000000');
  });

  it('prefers the profile display name and shows the handle beside it', () => {
    const event = makeEvent();
    render(EventCard, {
      props: { event, profile: { displayName: 'たけし', name: 'takeshi' } },
    });

    expect(screen.getByText('たけし')).toBeInTheDocument();
    expect(screen.getByText('@takeshi')).toBeInTheDocument();
    expect(screen.queryByText('pk000000…00000000')).not.toBeInTheDocument();
  });

  it('falls back to the handle when there is no display name', () => {
    render(EventCard, { props: { event: makeEvent(), profile: { name: 'takeshi' } } });

    expect(screen.getByText('takeshi')).toBeInTheDocument();
    // The handle would only repeat the name that is already shown.
    expect(screen.queryByText('@takeshi')).not.toBeInTheDocument();
  });

  it('renders the avatar without leaking the embedding page as a referrer', () => {
    render(EventCard, {
      props: {
        event: makeEvent(),
        profile: { name: 'takeshi', picture: 'https://example.com/a.png' },
      },
    });

    const avatar = screen.getByRole('img', { name: 'takeshi' });
    expect(avatar).toHaveAttribute('src', 'https://example.com/a.png');
    expect(avatar).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(avatar).toHaveAttribute('loading', 'lazy');
  });

  it('loads no image when avatars are switched off', () => {
    render(EventCard, {
      props: {
        event: makeEvent(),
        profile: { name: 'takeshi', picture: 'https://example.com/a.png' },
        showAvatar: false,
      },
    });

    expect(screen.queryByRole('img', { name: 'takeshi' })).not.toBeInTheDocument();
  });

  it('shows the time of day only, keeping the full date on hover', () => {
    const event = makeEvent({ created_at: 1_700_000_000 });
    const { container } = render(EventCard, { props: { event } });

    const time = container.querySelector('time');
    const rendered = time?.textContent?.trim() ?? '';
    const at = new Date(event.created_at * 1000);

    // Two digits, three parts, and nothing else: the date is dropped so the
    // header always fits on one line. `\p{Nd}` rather than `\d` because the
    // widget formats in the reader's locale, and not every locale numbers in
    // ASCII.
    expect(rendered).toMatch(/^\p{Nd}{2}\D\p{Nd}{2}\D\p{Nd}{2}$/u);
    // The event's own time, not the wall clock — a plain `new Date()` would
    // still satisfy the shape above.
    expect(rendered).toBe(
      at.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
    // The dropped date is still reachable: for machines on the element, and
    // for a mouse on the control that wraps it.
    expect(rendered).not.toContain(String(at.getFullYear()));
    expect(time).toHaveAttribute('datetime', at.toISOString());
    expect(time?.closest('button')).toHaveAttribute('title', at.toLocaleString());
  });

  it('reveals the full date when the timestamp is tapped, and hides it again', async () => {
    const event = makeEvent({ created_at: 1_700_000_000 });
    render(EventCard, { props: { event } });
    const full = new Date(event.created_at * 1000).toLocaleString();

    // Hidden to start with: the date is what the header drops to stay on one
    // line, and a card that showed it anyway would defeat the point.
    expect(screen.queryByText(full)).not.toBeInTheDocument();

    // A tap, not a hover — the reason this is a button at all is that a touch
    // reader can never see the `title`.
    const toggle = screen.getByRole('button', { name: '日付を表示' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(toggle);

    expect(screen.getByText(full)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '日付を隠す' })).toBe(toggle);

    await fireEvent.click(toggle);
    expect(screen.queryByText(full)).not.toBeInTheDocument();
  });

  it('marks a reply with the referenced event id', () => {
    const parent = 'b'.repeat(64);
    render(EventCard, {
      props: { event: makeEvent({ tags: [['e', parent, '', 'reply']] }) },
    });

    expect(screen.getByText('返信先')).toBeInTheDocument();
    expect(screen.getByTitle(parent)).toHaveTextContent('bbbbbbbb…bbbbbbbb');
  });

  it('marks a quote', () => {
    render(EventCard, {
      props: { event: makeEvent({ tags: [['q', 'c'.repeat(64)]] }) },
    });

    expect(screen.getByText('引用')).toBeInTheDocument();
  });

  it('shows no reference row on a standalone note', () => {
    render(EventCard, { props: { event: makeEvent() } });

    expect(screen.queryByText('返信先')).not.toBeInTheDocument();
    expect(screen.queryByText('引用')).not.toBeInTheDocument();
  });

  it('labels a cache hit', () => {
    render(EventCard, { props: { event: makeEvent(), origin: 'cache' } });

    const badge = screen.getByText('cache');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringContaining('ローカルキャッシュ'));
  });

  it('labels an event fetched from upstream', () => {
    render(EventCard, { props: { event: makeEvent(), origin: 'upstream' } });

    expect(screen.getByText('upstream')).toBeInTheDocument();
  });

  it('shows no origin badge when the origin is unknown', () => {
    render(EventCard, { props: { event: makeEvent() } });

    expect(screen.queryByText('cache')).not.toBeInTheDocument();
    expect(screen.queryByText('upstream')).not.toBeInTheDocument();
  });

  it('shows the verified badge only once the relay has validated the signature', () => {
    const { unmount } = render(EventCard, {
      props: { event: makeEvent(), status: 'validated' },
    });
    expect(screen.getByLabelText('署名検証済み')).toBeInTheDocument();
    unmount();

    render(EventCard, { props: { event: makeEvent(), status: 'pending' } });
    expect(screen.queryByLabelText('署名検証済み')).not.toBeInTheDocument();
  });

  describe('visibility reporting', () => {
    /** Records observers so a test can decide when the card "appears". */
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = [];
      readonly observed: Element[] = [];
      disconnected = false;

      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
        FakeIntersectionObserver.instances.push(this);
      }

      observe(node: Element): void {
        this.observed.push(node);
      }

      disconnect(): void {
        this.disconnected = true;
      }

      enter(): void {
        this.callback([{ isIntersecting: true }]);
      }

      scrollPast(): void {
        this.callback([{ isIntersecting: false }]);
      }
    }

    function withObserver(run: () => void): void {
      FakeIntersectionObserver.instances = [];
      const original = globalThis.IntersectionObserver;
      globalThis.IntersectionObserver =
        FakeIntersectionObserver as unknown as typeof IntersectionObserver;
      try {
        run();
      } finally {
        globalThis.IntersectionObserver = original;
      }
    }

    it('waits for the card to enter the viewport before reporting', () => {
      const onVisible = vi.fn();

      withObserver(() => {
        render(EventCard, { props: { event: makeEvent(), onVisible } });
        expect(onVisible).not.toHaveBeenCalled();

        const observer = FakeIntersectionObserver.instances[0];
        observer.scrollPast();
        expect(onVisible).not.toHaveBeenCalled();

        observer.enter();
        expect(onVisible).toHaveBeenCalledTimes(1);
        // One profile per author is enough; staying subscribed would re-report
        // on every scroll.
        expect(observer.disconnected).toBe(true);
      });
    });

    it('reports immediately where IntersectionObserver is unavailable', () => {
      const onVisible = vi.fn();
      // jsdom has no IntersectionObserver, which is also the situation in an
      // older browser: fetching eagerly beats never showing a name.
      expect(globalThis.IntersectionObserver).toBeUndefined();

      render(EventCard, { props: { event: makeEvent(), onVisible } });

      expect(onVisible).toHaveBeenCalledTimes(1);
    });
  });
});
