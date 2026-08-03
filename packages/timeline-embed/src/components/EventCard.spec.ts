// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import EventCard from './EventCard.svelte';

/**
 * Fire a `pointerenter` that carries a `pointerType`.
 *
 * jsdom implements no `PointerEvent`, so `fireEvent.pointerEnter` delivers a
 * bare `Event` and the property the card switches on would always be
 * undefined — which is the one thing these tests are about.
 */
function pointerEnter(node: Element, pointerType: 'mouse' | 'touch'): Promise<boolean> {
  const event = new Event('pointerenter');
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return fireEvent(node, event);
}

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

  it('shows the time of day only, keeping the full date one interaction away', () => {
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
    // The dropped date stays machine-readable; the tooltip covers the reader.
    expect(rendered).not.toContain(String(at.getFullYear()));
    expect(time).toHaveAttribute('datetime', at.toISOString());
  });

  it('opens the date tooltip on a tap and closes it on the next one', async () => {
    const event = makeEvent({ created_at: 1_700_000_000 });
    render(EventCard, { props: { event } });
    const full = new Date(event.created_at * 1000).toLocaleString();

    // Hidden to start with: the date is what the header drops to stay on one
    // line, and a card that showed it anyway would defeat the point.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: '日付を表示' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // A tap: the reason this is a button at all is that a touch reader has no
    // hover to open a tooltip with.
    await pointerEnter(toggle, 'touch');
    await fireEvent.click(toggle);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(full);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Announced with the timestamp rather than left as loose text on the card.
    expect(toggle).toHaveAttribute('aria-describedby', tooltip.id);
    expect(screen.getByRole('button', { name: '日付を隠す' })).toBe(toggle);

    // A tap leaves the pointer where it is, so the tooltip has to close on the
    // next tap rather than waiting for a pointerleave that never comes.
    await fireEvent.click(toggle);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens the date tooltip while a mouse rests on the timestamp', async () => {
    render(EventCard, { props: { event: makeEvent({ created_at: 1_700_000_000 }) } });
    const toggle = screen.getByRole('button', { name: '日付を表示' });

    await pointerEnter(toggle, 'mouse');
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await fireEvent.pointerLeave(toggle);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes the date tooltip on Escape, without moving the pointer', async () => {
    render(EventCard, { props: { event: makeEvent({ created_at: 1_700_000_000 }) } });
    const toggle = screen.getByRole('button', { name: '日付を表示' });

    await pointerEnter(toggle, 'mouse');
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // WCAG 2.1 §1.4.13: content shown on hover must be dismissable where it
    // is, without having to move the pointer off the trigger.
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
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
