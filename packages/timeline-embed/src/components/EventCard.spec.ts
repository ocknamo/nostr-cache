// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
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

  it('renders the body through NoteContent, keeping the .content hook', () => {
    const event = makeEvent({ content: 'see https://example.com/a' });
    const { container } = render(EventCard, { props: { event, showAvatar: false } });

    // The class is what the browser E2E suite reaches through the shadow root
    // for, so it has to survive the body moving into its own component.
    expect(container.querySelector('.content')).toHaveTextContent('see https://example.com/a');
    expect(screen.getByRole('link', { name: 'https://example.com/a' })).toBeInTheDocument();
  });

  it('passes showMedia down to the body', () => {
    const event = makeEvent({ content: 'https://cdn.example.com/a.jpg' });
    const { container } = render(EventCard, {
      props: { event, showAvatar: false, showMedia: false },
    });

    expect(container.querySelector('img')).toBeNull();
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

  describe('unverified events', () => {
    const card = (container: HTMLElement) => container.querySelector('.event-card');

    it('fades anything the relay has not vouched for', () => {
      // `pending` and "no status yet" are the same thing to a reader: the relay
      // validates lazily, so a card arrives unverified and may stay that way.
      for (const status of ['pending', 'unknown', undefined] as const) {
        const { container, unmount } = render(EventCard, {
          props: { event: makeEvent(), status },
        });

        expect(card(container)).toHaveClass('unverified');
        unmount();
      }
    });

    it('shows a validated event at full strength', () => {
      const { container } = render(EventCard, {
        props: { event: makeEvent(), status: 'validated' },
      });

      expect(card(container)).not.toHaveClass('unverified');
    });
  });

  it('opens the first card of a list downward, where there is room', async () => {
    const { container } = render(EventCard, {
      props: { event: makeEvent(), datePlacement: 'below' },
    });

    await fireEvent.click(screen.getByRole('button', { name: '日付を表示' }));

    // The list keeps only a small gap above the first card now, so its tooltip
    // has to flip rather than clip against the embed's top edge.
    expect(container.querySelector('.date-tip')).toHaveClass('below');
  });

  it('lifts the card while its tooltip is open', async () => {
    const { container } = render(EventCard, { props: { event: makeEvent() } });
    const card = container.querySelector('.event-card');

    expect(card).not.toHaveClass('tip-open');
    await fireEvent.click(screen.getByRole('button', { name: '日付を表示' }));

    // A faded card is its own stacking context, which traps the tooltip's
    // z-index inside it — the next card would otherwise paint over the tooltip.
    expect(card).toHaveClass('tip-open');
  });

  describe('action bar', () => {
    it('renders nothing of its own when the embedder asked for no buttons', () => {
      const { container } = render(EventCard, { props: { event: makeEvent() } });

      expect(container.querySelector('.actions')).toBeNull();
    });

    it('names an icon-only button for a screen reader', () => {
      render(EventCard, {
        props: { event: makeEvent(), actions: [{ id: 'like', label: 'いいね', icon: '♡' }] },
      });

      const button = screen.getByRole('button', { name: 'いいね' });
      expect(button).toHaveTextContent('♡');
      // The id is what a listener switches on, so keep it reachable from the DOM.
      expect(button).toHaveAttribute('data-action', 'like');
    });

    it('falls back to the label as the button text when no icon is given', () => {
      render(EventCard, {
        props: { event: makeEvent(), actions: [{ id: 'reply', label: '返信' }] },
      });

      expect(screen.getByRole('button', { name: '返信' })).toHaveTextContent('返信');
    });

    it('reports a press to the action and to the timeline, with its own event', async () => {
      const event = makeEvent({ id: 'note-1' });
      const onSelect = vi.fn();
      const onAction = vi.fn();
      const action = { id: 'zap', label: 'Zap', icon: '⚡', onSelect };
      render(EventCard, { props: { event, status: 'pending', actions: [action], onAction } });

      await fireEvent.click(screen.getByRole('button', { name: 'Zap' }));

      // The verdict comes along: the card shows unverified events, so a handler
      // that acts on the reader's behalf has to be able to see that.
      expect(onSelect).toHaveBeenCalledWith({ event, status: 'pending' });
      expect(onAction).toHaveBeenCalledWith(action, { event, status: 'pending' });
    });

    it('gives an icon button a native tooltip, and a label button none', () => {
      render(EventCard, {
        props: {
          event: makeEvent(),
          actions: [
            { id: 'zap', label: 'Zap', icon: '⚡' },
            { id: 'reply', label: '返信' },
          ],
        },
      });

      expect(screen.getByRole('button', { name: 'Zap' })).toHaveAttribute('title', 'Zap');
      // The text is right there; a title would only repeat it.
      expect(screen.getByRole('button', { name: '返信' })).not.toHaveAttribute('title');
    });

    it('still reports the press when the embedder handler throws', async () => {
      const onAction = vi.fn();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(EventCard, {
        props: {
          event: makeEvent(),
          actions: [
            {
              id: 'boom',
              label: 'Boom',
              onSelect: () => {
                throw new Error('nope');
              },
            },
          ],
          onAction,
        },
      });

      await fireEvent.click(screen.getByRole('button', { name: 'Boom' }));

      // One embedder's broken handler must not silence every other listener.
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('renders an icon as a Material Symbols ligature when asked', () => {
      render(EventCard, {
        props: {
          event: makeEvent(),
          materialIcons: 'rounded',
          actions: [{ id: 'like', label: 'いいね', icon: 'favorite' }],
        },
      });

      const icon = screen.getByRole('button', { name: 'いいね' }).querySelector('.action-icon');
      expect(icon).toHaveClass('material');
      expect(icon).toHaveTextContent('favorite');
      expect(icon?.getAttribute('style')).toContain('Material Symbols Rounded');
      // A ligature name is markup, not prose: a page translator turning
      // `favorite` into a word would turn the icon into gibberish.
      expect(icon).toHaveAttribute('translate', 'no');
    });

    it('lets one button opt out of Material icons, and another opt in', () => {
      const { container } = render(EventCard, {
        props: {
          event: makeEvent(),
          materialIcons: 'outlined',
          actions: [
            { id: 'like', label: 'いいね', icon: 'favorite' },
            { id: 'zap', label: 'Zap', icon: '⚡', iconType: 'text' as const },
          ],
        },
      });

      const icons = container.querySelectorAll('.action-icon');
      expect(icons[0]).toHaveClass('material');
      expect(icons[1]).not.toHaveClass('material');
    });

    it('leaves icons as literal text unless Material icons are turned on', () => {
      const { container } = render(EventCard, {
        props: { event: makeEvent(), actions: [{ id: 'like', label: 'いいね', icon: '♡' }] },
      });

      expect(container.querySelector('.action-icon')).not.toHaveClass('material');
    });

    it('shows the label beside the icon when the action asks for it', () => {
      render(EventCard, {
        props: {
          event: makeEvent(),
          actions: [{ id: 'reply', label: '返信', icon: '💬', showLabel: true }],
        },
      });

      const button = screen.getByRole('button', { name: '返信' });
      expect(button.querySelector('.action-icon')).toHaveTextContent('💬');
      expect(button.querySelector('.action-label')).toHaveTextContent('返信');
    });

    it('gives each button a part named after its id, for styling from outside', () => {
      render(EventCard, {
        props: { event: makeEvent(), actions: [{ id: 'zap', label: 'Zap', icon: '⚡' }] },
      });

      // `::part(action)` styles the row, `::part(action-zap)` just this one.
      expect(screen.getByRole('button', { name: 'Zap' })).toHaveAttribute(
        'part',
        'action action-zap'
      );
    });

    it('renders a disabled action as unpressable', () => {
      render(EventCard, {
        props: { event: makeEvent(), actions: [{ id: 'zap', label: 'Zap', disabled: true }] },
      });

      // The button attribute, not a guard in the handler: the browser is what
      // withholds the click, and `fireEvent` dispatches straight past it.
      expect(screen.getByRole('button', { name: 'Zap' })).toBeDisabled();
    });
  });

  describe('height cap', () => {
    /** Records observers so a test can decide when the note has been remeasured. */
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      readonly observed: Element[] = [];
      disconnected = false;

      constructor(private readonly callback: () => void) {
        FakeResizeObserver.instances.push(this);
      }

      observe(node: Element): void {
        this.observed.push(node);
      }

      disconnect(): void {
        this.disconnected = true;
      }

      resize(): void {
        this.callback();
      }
    }

    async function withObserver(run: () => void | Promise<void>): Promise<void> {
      FakeResizeObserver.instances = [];
      const original = globalThis.ResizeObserver;
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      try {
        await run();
      } finally {
        globalThis.ResizeObserver = original;
      }
    }

    /**
     * Make the note report more content than fits.
     *
     * jsdom lays nothing out, so every box is 0×0 and the card would never
     * consider itself overflowing on its own.
     */
    function overflow(note: Element, scrollHeight = 900): void {
      Object.defineProperty(note, 'scrollHeight', { value: scrollHeight, configurable: true });
      Object.defineProperty(note, 'clientHeight', { value: 300, configurable: true });
    }

    function note(container: HTMLElement): HTMLElement {
      const found = container.querySelector<HTMLElement>('.note');
      if (!found) {
        throw new Error('no .note in the card');
      }
      return found;
    }

    it('puts the body in its own box, so the cap has something to scroll', () => {
      const { container } = render(EventCard, {
        props: { event: makeEvent({ content: 'hello there' }) },
      });

      // The note is the only scrolling part of the card: the header, the
      // reference chips and the action row stay put above and below it.
      expect(note(container)).toContainElement(container.querySelector('.content'));
      expect(note(container)).not.toContainElement(container.querySelector('header'));
      expect(note(container)).not.toContainElement(container.querySelector('.actions'));
    });

    it('leaves a note that fits out of the tab order', () => {
      const { container } = render(EventCard, { props: { event: makeEvent() } });

      // One tab stop per card, on a 50-card timeline, for boxes that do not
      // scroll: the affordance only appears where there is something to reach.
      expect(note(container)).not.toHaveAttribute('tabindex');
      expect(screen.queryByRole('region')).not.toBeInTheDocument();
      expect(note(container)).not.toHaveClass('overflowing');
    });

    it('announces an overflowing note as a scroll area a keyboard can reach', async () => {
      await withObserver(async () => {
        const { container } = render(EventCard, {
          props: { event: makeEvent({ content: 'とても長い本文' }) },
        });
        overflow(note(container));

        // A note grows after first paint — an attached image loads, a profile
        // turns an npub into a name — so the box is remeasured, not judged once.
        FakeResizeObserver.instances[0].resize();
        await tick();

        const scroller = screen.getByRole('region', { name: '投稿本文（スクロールできます）' });
        expect(scroller).toBe(note(container));
        // WCAG 2.1.1: a scrollable region has to be operable without a mouse.
        expect(scroller).toHaveAttribute('tabindex', '0');
        // Overlay scrollbars are invisible until a scroll starts, so the fade
        // is the only sign that the post was cut.
        expect(scroller).toHaveClass('overflowing');
        expect(scroller).not.toHaveClass('at-end');
      });
    });

    it('watches the note itself and what is inside it', async () => {
      await withObserver(() => {
        const { container } = render(EventCard, {
          props: { event: makeEvent({ content: 'https://cdn.example.com/a.jpg' }) },
        });

        const observer = FakeResizeObserver.instances[0];
        // The box for a resized embed, the content for a note that grew inside
        // it (here the attachment list); neither alone catches both.
        expect(observer.observed).toContain(note(container));
        expect(observer.observed).toContain(container.querySelector('.media'));
      });
    });

    it('drops the fade once the note is scrolled to the end', async () => {
      const { container } = render(EventCard, { props: { event: makeEvent() } });
      const scroller = note(container);
      overflow(scroller);

      // No ResizeObserver here (jsdom has none): a scroll remeasures too, which
      // is what keeps the fade in step with the reader.
      await fireEvent.scroll(scroller);
      expect(scroller).toHaveClass('overflowing');
      expect(scroller).not.toHaveClass('at-end');

      scroller.scrollTop = 600;
      await fireEvent.scroll(scroller);

      // Fading the last line of a note that has ended reads as a bug, not a
      // hint.
      expect(scroller).toHaveClass('at-end');
    });
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
