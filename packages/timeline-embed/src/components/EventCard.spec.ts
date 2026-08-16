// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import EventCard from './EventCard.svelte';

const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
/** Three more references, to put a body over the cap a nested quote has. */
const MORE_NOTES = [
  'note1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqskcx45n',
  'note1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqmwpjpm',
  'note1qvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvps7ucghe',
];
const MORE_NOTES_HEX = [
  '0101010101010101010101010101010101010101010101010101010101010101',
  '0202020202020202020202020202020202020202020202020202020202020202',
  '0303030303030303030303030303030303030303030303030303030303030303',
];

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

  it('asks for the reply target once the chip is on screen', () => {
    const parent = 'b'.repeat(64);
    const onEmbedRequest = vi.fn();
    render(EventCard, {
      props: { event: makeEvent({ tags: [['e', parent, '', 'reply']] }), onEmbedRequest },
    });

    expect(onEmbedRequest).toHaveBeenCalledWith({
      key: parent,
      filter: { ids: [parent] },
      replaceable: false,
    });
  });

  it('previews the reply target once it has been fetched', () => {
    const parent = 'b'.repeat(64);
    const { container } = render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '親の\n本文' }) }],
        ]),
        onEmbedRequest: () => {},
      },
    });

    expect(screen.getByText('親の 本文')).toBeInTheDocument();
    expect(container.querySelector('.ref .avatar')).not.toBeNull();
    expect(screen.queryByText('bbbbbbbb…bbbbbbbb')).not.toBeInTheDocument();
  });

  it('names the reply target author for a screen reader', () => {
    const parent = 'b'.repeat(64);
    const target = makeEvent({ pubkey: 'a'.repeat(64), content: '親の本文' });
    const props = {
      event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
      embeds: new Map([[parent, { status: 'ready' as const, event: target }]]),
      // No `picture`, so the avatar falls back to the aria-hidden block.
      profiles: new Map([[target.pubkey, { displayName: 'アリス' }]]),
      onEmbedRequest: () => {},
    };
    const { container, unmount } = render(EventCard, { props });

    expect(container.querySelector('.ref-author')).toHaveTextContent('アリス');
    unmount();

    render(EventCard, { props: { ...props, onNavigate: () => {} } });

    expect(
      screen.getByRole('button', { name: '返信先の投稿を開く: アリス「親の本文」' })
    ).toBeInTheDocument();
  });

  it('navigates from the previewed chip', async () => {
    const parent = 'b'.repeat(64);
    const onNavigate = vi.fn();
    render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '親の本文' }) }],
        ]),
        onEmbedRequest: () => {},
        onNavigate,
      },
    });

    await fireEvent.click(screen.getByText('親の本文'));

    expect(onNavigate).toHaveBeenCalledWith(parent);
  });

  it('keeps the abbreviated id while the reply target is still loading', () => {
    const parent = 'b'.repeat(64);
    render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([[parent, { status: 'loading' as const }]]),
        onEmbedRequest: () => {},
      },
    });

    expect(screen.getByTitle(parent)).toHaveTextContent('bbbbbbbb…bbbbbbbb');
  });

  it('keeps the abbreviated id when the reply target cannot be found', () => {
    const parent = 'b'.repeat(64);
    render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([[parent, { status: 'missing' as const }]]),
        onEmbedRequest: () => {},
      },
    });

    expect(screen.getByTitle(parent)).toHaveTextContent('bbbbbbbb…bbbbbbbb');
  });

  it('falls back to the abbreviated id when the target has nothing to preview', () => {
    const parent = 'b'.repeat(64);
    render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '   ' }) }],
        ]),
        onEmbedRequest: () => {},
      },
    });

    expect(screen.getByTitle(parent)).toHaveTextContent('bbbbbbbb…bbbbbbbb');
  });

  it('drops the chip avatar with avatars off, keeping the preview', () => {
    const parent = 'b'.repeat(64);
    const { container } = render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '親の本文' }) }],
        ]),
        showAvatar: false,
        onEmbedRequest: () => {},
      },
    });

    expect(container.querySelector('.ref .avatar')).toBeNull();
    expect(screen.getByText('親の本文')).toBeInTheDocument();
  });

  it('neither fetches nor previews the reply target with embeds switched off', () => {
    const parent = 'b'.repeat(64);
    const onEmbedRequest = vi.fn();
    const { container } = render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        // Already resolved, which is the case `show-embeds="false"` has to keep
        // off the screen: drawing it would load the parent author's avatar from
        // a third-party host the page never named.
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '親の本文' }) }],
        ]),
        showEmbeds: false,
        onEmbedRequest,
      },
    });

    expect(onEmbedRequest).not.toHaveBeenCalled();
    expect(screen.queryByText('親の本文')).not.toBeInTheDocument();
    expect(container.querySelector('.ref .avatar')).toBeNull();
    expect(screen.getByTitle(parent)).toHaveTextContent('bbbbbbbb…bbbbbbbb');
  });

  it('previews an embed resolved by something else, with no way to fetch', () => {
    const parent = 'b'.repeat(64);
    render(EventCard, {
      props: {
        event: makeEvent({ tags: [['e', parent, '', 'reply']] }),
        embeds: new Map([
          [parent, { status: 'ready' as const, event: makeEvent({ content: '親の本文' }) }],
        ]),
      },
    });

    expect(screen.getByText('親の本文')).toBeInTheDocument();
  });

  it('leaves a quote chip as the reference it always was', () => {
    const onEmbedRequest = vi.fn();
    render(EventCard, {
      props: {
        event: makeEvent({ content: 'no references here', tags: [['q', NOTE_HEX]] }),
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: '引用元の本文' }) }],
        ]),
        onEmbedRequest,
      },
    });

    expect(screen.getByTitle(NOTE_HEX)).toHaveTextContent('5c04292b…1b6a7f11');
    expect(screen.queryByText('引用元の本文')).not.toBeInTheDocument();
    expect(onEmbedRequest).not.toHaveBeenCalled();
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

  it('shows a URL repeated on both sides of a card once, not once per segment', () => {
    // The card splits the body into two text segments, each with its own
    // slice of parts — the dedup that used to run once over the whole note
    // must still span both slices rather than resetting at the card.
    const url = 'https://cdn.example.com/a.jpg';
    const event = makeEvent({ content: `${url} nostr:${NOTE} again ${url}` });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        onEmbedRequest: () => {},
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: 'quoted' }) }],
        ]),
      },
    });

    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders a nostr: reference as a nested card and asks for the event', () => {
    const onEmbedRequest = vi.fn();
    const event = makeEvent({ content: `see nostr:${NOTE} for context` });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        onEmbedRequest,
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: 'quoted body' }) }],
        ]),
      },
    });

    expect(onEmbedRequest).toHaveBeenCalledWith({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
    });
    // The reference is a card now, so it is no longer a chip in the text —
    // and the card sits where the reference was, splitting the text in two
    // rather than collapsing it to one run above the card.
    const runs = container.querySelectorAll('.note > .content');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveTextContent('see');
    expect(runs[1]).toHaveTextContent('for context');
    expect(container.querySelector('.quote')).not.toBeNull();
  });

  it('renders each card where its own reference sat in the text, in source order', () => {
    const event = makeEvent({ content: `No1: ${NOTE}\nNo2: ${MORE_NOTES[0]}` });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        onEmbedRequest: () => {},
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: 'quoted 1' }) }],
          [
            MORE_NOTES_HEX[0],
            { status: 'ready' as const, event: makeEvent({ content: 'quoted 2' }) },
          ],
        ]),
      },
    });

    // Checks for `.embed` directly rather than inferring it from "not
    // `.content`" — a text segment with an attachment also renders a
    // `ul.media` sibling, which the inverse check would misclassify.
    const order = [...container.querySelectorAll('.note > *')].map((node) =>
      node.classList.contains('embed') ? 'embed' : 'text'
    );
    expect(order).toEqual(['text', 'embed', 'text', 'embed']);

    const runs = container.querySelectorAll('.note > .content');
    expect(runs[0]).toHaveTextContent('No1:');
    expect(runs[1]).toHaveTextContent('No2:');
  });

  it('renders more nested cards than a quote would, being a timeline card', () => {
    // The card renders at depth 0, where the cap is MAX_EMBEDS_PER_TOP_NOTE
    // rather than the smaller one a quote inside it gets. Four references would
    // come back as two if this card ever started rendering itself as nested.
    const refs = [NOTE, ...MORE_NOTES];
    const event = makeEvent({ content: refs.map((ref) => `nostr:${ref}`).join(' ') });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        onEmbedRequest: () => {},
        embeds: new Map(
          [NOTE_HEX, ...MORE_NOTES_HEX].map((hex, index) => [
            hex,
            { status: 'ready' as const, event: makeEvent({ content: `quoted ${index}` }) },
          ])
        ),
      },
    });

    expect(container.querySelectorAll('.quote')).toHaveLength(refs.length);
  });

  it('drops the quote chip for a reference the body already shows as a card', () => {
    // NIP-18's `q` tag and NIP-27's body reference name the same event, and
    // showing both would point at the card sitting right underneath.
    const event = makeEvent({ content: `nostr:${NOTE}`, tags: [['q', NOTE_HEX]] });
    render(EventCard, { props: { event, showAvatar: false, onEmbedRequest: () => {} } });

    expect(screen.queryByText('引用')).not.toBeInTheDocument();
  });

  it('keeps the reply chip even when the body quotes the parent too', () => {
    // "返信先" says something the quote card does not, and a reply's parent is
    // named by an `e` tag whether or not the author also wrote it in the body.
    const event = makeEvent({
      content: `nostr:${NOTE}`,
      tags: [['e', NOTE_HEX, '', 'reply']],
    });
    render(EventCard, { props: { event, showAvatar: false, onEmbedRequest: () => {} } });

    expect(screen.getByText('返信先')).toBeInTheDocument();
  });

  it('keeps the quote chip for an event the body does not reference', () => {
    const event = makeEvent({ content: 'no references here', tags: [['q', NOTE_HEX]] });
    render(EventCard, { props: { event, showAvatar: false } });

    expect(screen.getByText('引用')).toBeInTheDocument();
  });

  it('leaves the body alone when there is nothing to fetch through', () => {
    // Lifting the reference out of the text with no way to resolve it would
    // lose it: the card would show a placeholder that never resolves.
    const event = makeEvent({ content: `see nostr:${NOTE}` });
    const { container } = render(EventCard, { props: { event, showAvatar: false } });

    expect(container.querySelector('.quote')).toBeNull();
    expect(container.querySelector('.content')).toHaveTextContent('see note1tszz…elrl');
  });

  it('leaves a reference as a chip when embeds are switched off', () => {
    const onEmbedRequest = vi.fn();
    const event = makeEvent({ content: `see nostr:${NOTE}` });
    const { container } = render(EventCard, {
      props: { event, showAvatar: false, showEmbeds: false, onEmbedRequest },
    });

    expect(container.querySelector('.quote')).toBeNull();
    expect(onEmbedRequest).not.toHaveBeenCalled();
    expect(container.querySelector('.content')).toHaveTextContent('see note1tszz…elrl');
  });

  it('lets an unverified card carry the fade for the quotes inside it', () => {
    // The card is already faded, and `opacity` multiplies: a quote fading again
    // inside it would come out at 0.36 rather than 0.6.
    const event = makeEvent({ content: `nostr:${NOTE}` });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: 'quoted' }) }],
        ]),
      },
    });

    expect(container.querySelector('.event-card')).toHaveClass('unverified');
    expect(container.querySelector('.quote')).not.toHaveClass('unverified');
  });

  it('keeps the quotes inside the scrolling note, under the height cap', () => {
    // Outside it, a chain of quotes would grow the card past
    // --nt-card-max-height instead of scrolling within it.
    const event = makeEvent({ content: `nostr:${NOTE}` });
    const { container } = render(EventCard, {
      props: {
        event,
        showAvatar: false,
        embeds: new Map([
          [NOTE_HEX, { status: 'ready' as const, event: makeEvent({ content: 'quoted' }) }],
        ]),
      },
    });

    expect(container.querySelector('.note .quote')).not.toBeNull();
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

  describe('author press', () => {
    const AUTHOR = { id: 'open-profile', label: 'プロフィールを開く' };

    it('leaves the author plain until an embedder asks for the press', () => {
      const { container } = render(EventCard, {
        props: { event: makeEvent(), profile: { name: 'takeshi' } },
      });

      expect(container.querySelector('.identity')?.tagName).toBe('SPAN');
      expect(container.querySelector('.author-avatar')).toBeNull();
    });

    it('names the press before whose it is, and keeps the name on screen', () => {
      render(EventCard, {
        props: {
          event: makeEvent(),
          profile: { displayName: 'たけし', name: 'takeshi' },
          authorAction: AUTHOR,
        },
      });

      // The handle is in the label too: an `aria-label` replaces the text
      // inside the button, so leaving it out would take the @handle away from a
      // screen reader while everyone else keeps seeing it.
      const author = screen.getByRole('button', { name: 'プロフィールを開く: たけし @takeshi' });
      expect(author).toHaveTextContent('たけし');
      expect(author).toHaveTextContent('@takeshi');
    });

    it('names the press with the display name alone when there is no handle', () => {
      render(EventCard, {
        props: { event: makeEvent(), profile: { displayName: 'たけし' }, authorAction: AUTHOR },
      });

      expect(
        screen.getByRole('button', { name: 'プロフィールを開く: たけし' })
      ).toBeInTheDocument();
    });

    it('reports the press with the author it was on', async () => {
      const event = makeEvent({ id: 'note-1' });
      const onAction = vi.fn();
      render(EventCard, { props: { event, status: 'validated', authorAction: AUTHOR, onAction } });

      await fireEvent.click(screen.getByRole('button', { name: /プロフィールを開く/ }));

      // `pubkey` rather than only `event.pubkey`: the same press belongs on a
      // reactor's row and on a mention, where the two differ.
      expect(onAction).toHaveBeenCalledWith(AUTHOR, {
        event,
        status: 'validated',
        pubkey: event.pubkey,
      });
    });

    it('carries no pubkey on a button press, which is about no one', async () => {
      const onAction = vi.fn();
      render(EventCard, {
        props: {
          event: makeEvent(),
          actions: [{ id: 'zap', label: 'Zap' }],
          authorAction: AUTHOR,
          onAction,
        },
      });

      await fireEvent.click(screen.getByRole('button', { name: 'Zap' }));

      expect(onAction.mock.calls[0][1]).not.toHaveProperty('pubkey');
    });

    it('presses from the avatar too, without a second stop for a screen reader', async () => {
      const event = makeEvent();
      const onAction = vi.fn();
      const { container } = render(EventCard, {
        props: {
          event,
          profile: { name: 'takeshi', picture: 'https://example.com/a.png' },
          authorAction: AUTHOR,
          onAction,
        },
      });

      const avatar = container.querySelector<HTMLElement>('.author-avatar');
      expect(avatar).toHaveAttribute('tabindex', '-1');
      expect(avatar).toHaveAttribute('aria-hidden', 'true');
      // `tabindex="-1"` only covers the keyboard: a pointer press focuses a
      // button by itself, and focus must not land on something hidden from the
      // accessibility tree. Cancelling the press is what withholds it.
      const press = new Event('pointerdown', { bubbles: true, cancelable: true });
      avatar?.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      // Both targets exist, but only the identity is in the accessibility tree.
      expect(screen.getAllByRole('button', { name: /プロフィールを開く/ })).toHaveLength(1);

      await fireEvent.click(avatar as HTMLElement);
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('exposes both targets as parts, for styling from outside', () => {
      const { container } = render(EventCard, {
        props: {
          event: makeEvent(),
          profile: { name: 'takeshi', picture: 'https://example.com/a.png' },
          authorAction: AUTHOR,
        },
      });

      expect(container.querySelector('.identity')).toHaveAttribute('part', 'author');
      expect(container.querySelector('.author-avatar')).toHaveAttribute('part', 'author-avatar');
    });
  });

  describe('height cap', () => {
    function note(container: HTMLElement): HTMLElement {
      const found = container.querySelector<HTMLElement>('.note');
      if (!found) {
        throw new Error('no .note in the card');
      }
      return found;
    }

    it('puts the body in its own box, so the cap has something to scroll', () => {
      const { container } = render(EventCard, {
        props: {
          event: makeEvent({ content: 'hello there', tags: [['e', 'b'.repeat(64), '', 'reply']] }),
          actions: [{ id: 'like', label: 'いいね', icon: '♡' }],
        },
      });

      // Only the body scrolls: the header, the chips and the action row stay
      // in place while a long note moves under them.
      expect(note(container)).toContainElement(container.querySelector('.content'));
      expect(note(container)).not.toContainElement(container.querySelector('header'));
      expect(note(container)).not.toContainElement(container.querySelector('.refs'));
      expect(note(container)).not.toContainElement(container.querySelector('.actions'));
    });

    it('keeps the attachments inside the scrolling box', () => {
      const { container } = render(EventCard, {
        props: { event: makeEvent({ content: 'https://cdn.example.com/a.jpg' }) },
      });

      expect(note(container)).toContainElement(container.querySelector('.media'));
    });

    it('adds no scroll attributes of its own', () => {
      const { container } = render(EventCard, { props: { event: makeEvent() } });

      // The tab stop is the browser's own handling of a scroll container,
      // applied only while the note scrolls. Nothing here measures anything,
      // so nothing here can put a stray tab stop on all 50 cards.
      expect(note(container)).not.toHaveAttribute('tabindex');
      expect(note(container)).not.toHaveAttribute('role');
      expect(note(container)).not.toHaveAttribute('aria-label');
    });

    it('exposes the scroll box as a part, so an embed can style it', () => {
      const { container } = render(EventCard, { props: { event: makeEvent() } });

      expect(note(container)).toHaveAttribute('part', 'note');
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
