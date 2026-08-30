// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { parseContent } from '../lib/content-parts.ts';
import type { EmbedSource, EmbeddedEvent } from '../lib/note-embeds.ts';
import type { Profile } from '../lib/profile.ts';
import { makeEvent } from '../test-fixtures.ts';
import EmbeddedNote from './EmbeddedNote.svelte';

const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
/** A second quotable event, so a quote can quote something. */
const OTHER_NOTE = 'note1424242424242424242424242424242424242424242424242424qv3q9y6';
const OTHER_NOTE_HEX = 'aa'.repeat(32);

/** The card's source for a body holding one reference. */
function sourceOf(content: string): EmbedSource {
  const part = parseContent(content).find((candidate) => candidate.kind === 'entity');
  if (!part) {
    throw new Error(`no entity in ${content}`);
  }
  return { kind: 'entity', part };
}

/** A resolved quote of `content`, keyed the way the controller keys it. */
function ready(key: string, content: string, id = key): Map<string, EmbeddedEvent> {
  return new Map([[key, { status: 'ready', event: makeEvent({ id, content }) }]]);
}

describe('EmbeddedNote', () => {
  it('asks for the referenced event when it appears', () => {
    const onEmbedRequest = vi.fn();
    render(EmbeddedNote, {
      props: { source: sourceOf(`nostr:${NOTE}`), depth: 1, onEmbedRequest },
    });

    // jsdom has no IntersectionObserver, so `whenVisible` reports immediately.
    expect(onEmbedRequest).toHaveBeenCalledWith({
      key: NOTE_HEX,
      filter: { ids: [NOTE_HEX] },
      replaceable: false,
    });
  });

  it('shows a placeholder while the lookup is in flight', () => {
    render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'loading' }]]),
      },
    });

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('falls back to the abbreviated chip when nothing came back', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'missing' }]]),
      },
    });

    // No frame: one would claim there is a post here.
    expect(container.querySelector('.quote')).toBeNull();
    expect(screen.getByTitle(`nostr:${NOTE}`)).toHaveTextContent('note1tszz…elrl');
  });

  it('renders an event named by an id alone, and abbreviates it while it is not here', () => {
    const { container, rerender } = render(EmbeddedNote, {
      props: {
        source: { kind: 'id', id: NOTE_HEX } as const,
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'missing' }]]),
      },
    });

    expect(screen.getByTitle(NOTE_HEX)).toHaveTextContent('5c04292b…1b6a7f11');

    rerender({ embeds: ready(NOTE_HEX, 'reposted body') });
    expect(container.querySelector('.content')).toHaveTextContent('reposted body');
  });

  it('draws a quoted repost as its own label and card, never as the JSON it carries', () => {
    const reposted = 'c'.repeat(64);
    const onEmbedRequest = vi.fn();
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        onEmbedRequest,
        embeds: new Map<string, EmbeddedEvent>([
          [
            NOTE_HEX,
            {
              status: 'ready',
              event: makeEvent({
                id: NOTE_HEX,
                kind: 6,
                content: JSON.stringify(makeEvent({ id: reposted, content: 'もとの投稿' })),
                tags: [['e', reposted]],
              }),
            },
          ],
          [
            reposted,
            { status: 'ready', event: makeEvent({ id: reposted, content: 'もとの投稿' }) },
          ],
        ]),
      },
    });

    expect(container.querySelector('.quote-body')).not.toHaveTextContent('"kind"');
    expect(screen.getByText('リポスト')).toBeInTheDocument();
    expect(container.querySelector('.quote .quote .content')).toHaveTextContent('もとの投稿');
  });

  it('shows the chip rather than a placeholder when nobody can fetch for it', () => {
    // No `onEmbedRequest`: the lookup is never going to happen, so a "loading"
    // frame would sit there for the life of the page.
    const { container } = render(EmbeddedNote, {
      props: { source: sourceOf(`nostr:${NOTE}`), depth: 1 },
    });

    expect(container.querySelector('.quote')).toBeNull();
    expect(screen.getByTitle(`nostr:${NOTE}`)).toHaveTextContent('note1tszz…elrl');
  });

  it('renders the quoted body inside a frame', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
      },
    });

    expect(container.querySelector('.quote')).not.toBeNull();
    expect(container.querySelector('.content')).toHaveTextContent('quoted body');
  });

  it('draws a quoted reaction as its glyph, like the card it was quoted from', () => {
    const embeds = new Map([
      [NOTE_HEX, { status: 'ready', event: makeEvent({ id: NOTE_HEX, kind: 7, content: '+' }) }],
    ] as const);
    const { container } = render(EmbeddedNote, {
      props: { source: sourceOf(`nostr:${NOTE}`), depth: 1, embeds },
    });

    expect(container.querySelector('.content')).toHaveTextContent(/^⭐$/);
  });

  it('renders a hostile quoted body as inert text', () => {
    // The quoted event is upstream-controlled and arrives through a different
    // path from the timeline's own, so pin it to the same guarantee: markup is
    // never built, and a non-http scheme never reaches an `href`.
    const hostile = '<img src=x onerror=alert(1)> javascript:alert(2) <script>alert(3)</script>';
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, hostile),
      },
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.content')).toHaveTextContent(hostile);
  });

  it('never gives a quoted attachment a non-http scheme', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'https://cdn.example.com/a.jpg data:text/html;base64,PHN2Zz4='),
      },
    });

    for (const node of container.querySelectorAll('img, a')) {
      expect(node.getAttribute('src') ?? node.getAttribute('href')).toMatch(/^https?:/);
    }
  });

  it('puts the avatar in the header row rather than in a column of its own', () => {
    // The whole point of the component: the body must not be indented past the
    // avatar, so nesting does not narrow it level by level.
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
      },
    });

    expect(container.querySelector('.quote-header .avatar')).not.toBeNull();
    const body = container.querySelector('.content');
    expect(body?.parentElement?.classList.contains('quote-header')).toBe(false);
  });

  it('names the quoted author once their profile is known', () => {
    const event = makeEvent({ id: NOTE_HEX, pubkey: 'f'.repeat(64), content: 'quoted' });
    const profiles = new Map<string, Profile>([['f'.repeat(64), { displayName: 'たけし' }]]);
    render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'ready', event }]]),
        profiles,
      },
    });

    expect(screen.getByText('たけし')).toBeInTheDocument();
  });

  it('fades a quote the relay has not vouched for, and stops once it has', () => {
    const props = {
      source: sourceOf(`nostr:${NOTE}`),
      depth: 1,
      embeds: ready(NOTE_HEX, 'quoted body'),
    };
    const faded = render(EmbeddedNote, { props });
    expect(faded.container.querySelector('.quote')).toHaveClass('unverified');

    const validated = render(EmbeddedNote, {
      props: { ...props, validationStatuses: new Map([[NOTE_HEX, 'validated' as const]]) },
    });
    expect(validated.container.querySelector('.quote')).not.toHaveClass('unverified');
  });

  it('leaves the fade to the outermost unverified box', () => {
    // `opacity` multiplies down the tree: five unverified levels each at 0.6
    // would come out under 8%, which is invisible rather than faded.
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        ancestorUnverified: true,
        embeds: ready(NOTE_HEX, 'quoted body'),
      },
    });

    expect(container.querySelector('.quote')).not.toHaveClass('unverified');
  });

  it('does not fade a nested quote under one that is already faded', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map([
          ...ready(NOTE_HEX, `outer nostr:${OTHER_NOTE}`),
          ...ready(OTHER_NOTE_HEX, 'inner'),
        ]),
      },
    });

    const [outer, inner] = container.querySelectorAll('.quote');
    expect(outer).toHaveClass('unverified');
    expect(inner).not.toHaveClass('unverified');
  });

  it('nests a quote inside a quote', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map([
          ...ready(NOTE_HEX, `outer nostr:${OTHER_NOTE}`),
          ...ready(OTHER_NOTE_HEX, 'inner'),
        ]),
      },
    });

    const bodies = [...container.querySelectorAll('.content')].map((node) => node.textContent);
    expect(bodies).toEqual(['outer', 'inner']);
  });

  it('places the nested card where its own reference sat in the quoted text', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map([
          ...ready(NOTE_HEX, `before ${OTHER_NOTE} after`),
          ...ready(OTHER_NOTE_HEX, 'inner'),
        ]),
      },
    });

    // Scoped to the outer quote's own body, so the inner quote's `.content`
    // (nested two levels down, inside its own `.embed` > `.quote-body`) is not
    // picked up as one of the outer note's own text runs.
    const body = container.querySelector(':scope > .quote > .quote-body');
    const order = [...(body?.children ?? [])].map((node) =>
      node.classList.contains('embed') ? 'embed' : 'text'
    );
    expect(order).toEqual(['text', 'embed', 'text']);

    const runs = body?.querySelectorAll(':scope > .content') ?? [];
    expect(runs[0]).toHaveTextContent('before');
    expect(runs[1]).toHaveTextContent('after');
  });

  it('stops nesting at the depth cap, leaving the reference as a chip', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        // Depth 5 is the last card that is drawn, so its own references stay
        // in its text rather than opening a sixth level.
        source: sourceOf(`nostr:${NOTE}`),
        depth: 5,
        embeds: new Map([
          ...ready(NOTE_HEX, `outer nostr:${OTHER_NOTE}`),
          ...ready(OTHER_NOTE_HEX, 'inner'),
        ]),
      },
    });

    expect(container.querySelectorAll('.quote')).toHaveLength(1);
    expect(container.querySelector('.content')).toHaveTextContent('outer note14242…q9y6');
  });

  it('leaves the quote unpressable until a note action is declared', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
      },
    });

    expect(container.querySelector('.open')).toBeNull();
  });

  it('reports a press on the quote with the quoted event', async () => {
    const onAction = vi.fn();
    render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
        validationStatuses: new Map([[NOTE_HEX, 'validated' as const]]),
        noteAction: { id: 'open-post', label: '投稿を開く' },
        onAction,
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: /投稿を開く/ }));

    expect(onAction).toHaveBeenCalledTimes(1);
    const [action, context] = onAction.mock.calls[0];
    expect(action).toEqual({ id: 'open-post', label: '投稿を開く' });
    // The quoted post, not the note quoting it: that is what the press opens.
    expect(context.event.id).toBe(NOTE_HEX);
    expect(context.status).toBe('validated');
  });

  it('covers the whole frame with the press, so the card itself is the target', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
        noteAction: { id: 'open-post', label: '投稿を開く' },
      },
    });

    // The press is a child of the frame it opens, laid over it — not a button
    // added under the body.
    const quote = container.querySelector('.quote');
    const open = quote?.querySelector('.open');
    expect(open).not.toBeNull();
    expect(open?.textContent?.trim()).toBe('');
  });

  it('offers the press on a nested quote too', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map([
          ...ready(NOTE_HEX, `outer nostr:${OTHER_NOTE}`),
          ...ready(OTHER_NOTE_HEX, 'inner'),
        ]),
        noteAction: { id: 'open-post', label: '投稿を開く' },
      },
    });

    expect(container.querySelectorAll('.open')).toHaveLength(2);
  });

  it('names the quoted author in the accessible name of the press', () => {
    const event = makeEvent({ id: NOTE_HEX, pubkey: 'f'.repeat(64), content: 'quoted' });
    render(EmbeddedNote, {
      props: {
        source: sourceOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'ready', event }]]),
        profiles: new Map<string, Profile>([['f'.repeat(64), { displayName: 'たけし' }]]),
        noteAction: { id: 'open-post', label: '投稿を開く' },
      },
    });

    expect(screen.getByRole('button', { name: '投稿を開く: たけし' })).toBeInTheDocument();
  });

  describe('author press', () => {
    const AUTHOR = { id: 'open-profile', label: 'プロフィールを開く' };
    const QUOTED = 'f'.repeat(64);
    const NOTE_ACTION = { id: 'open-post', label: '投稿を開く' };

    /** A quote of `content`, written by QUOTED. */
    function quoted(content: string): Map<string, EmbeddedEvent> {
      return new Map<string, EmbeddedEvent>([
        [
          NOTE_HEX,
          { status: 'ready', event: makeEvent({ id: NOTE_HEX, pubkey: QUOTED, content }) },
        ],
      ]);
    }

    it('leaves the header plain until an embedder asks for the press', () => {
      const { container } = render(EmbeddedNote, {
        props: { source: sourceOf(`nostr:${NOTE}`), depth: 1, embeds: quoted('quoted body') },
      });

      expect(container.querySelector('.quote-author')).toBeNull();
    });

    it('reports the quoted author, with the quoted post as the event', async () => {
      const onAction = vi.fn();
      render(EmbeddedNote, {
        props: {
          source: sourceOf(`nostr:${NOTE}`),
          depth: 1,
          embeds: quoted('quoted body'),
          profiles: new Map<string, Profile>([[QUOTED, { displayName: 'たけし' }]]),
          validationStatuses: new Map([[NOTE_HEX, 'validated' as const]]),
          authorAction: AUTHOR,
          onAction,
        },
      });

      await fireEvent.click(screen.getByRole('button', { name: 'プロフィールを開く: たけし' }));

      expect(onAction).toHaveBeenCalledTimes(1);
      const [action, context] = onAction.mock.calls[0];
      expect(action).toEqual(AUTHOR);
      expect(context.pubkey).toBe(QUOTED);
      expect(context.event.id).toBe(NOTE_HEX);
      expect(context.status).toBe('validated');
    });

    it('keeps the header out of the frame press, so each opens its own thing', async () => {
      const onAction = vi.fn();
      const { container } = render(EmbeddedNote, {
        props: {
          source: sourceOf(`nostr:${NOTE}`),
          depth: 1,
          embeds: quoted('quoted body'),
          authorAction: AUTHOR,
          noteAction: NOTE_ACTION,
          onAction,
        },
      });

      expect(container.querySelector('.quote-avatar')).not.toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: /プロフィールを開く/ }));
      await fireEvent.click(screen.getByRole('button', { name: /投稿を開く/ }));

      expect(onAction.mock.calls.map(([action]) => action.id)).toEqual([
        'open-profile',
        'open-post',
      ]);
      expect(onAction.mock.calls[0][1].pubkey).toBe(QUOTED);
      // A post was pressed, not a person.
      expect(onAction.mock.calls[1][1].pubkey).toBeUndefined();
    });

    it('keeps the avatar out of the tab order, as the card does', () => {
      const { container } = render(EmbeddedNote, {
        props: {
          source: sourceOf(`nostr:${NOTE}`),
          depth: 1,
          embeds: quoted('quoted body'),
          authorAction: AUTHOR,
        },
      });

      const avatar = container.querySelector('.quote-avatar');
      expect(avatar).toHaveAttribute('tabindex', '-1');
      expect(avatar).toHaveAttribute('aria-hidden', 'true');
    });

    it('reports a mention in the quoted body with the quote as the event', async () => {
      const onAction = vi.fn();
      render(EmbeddedNote, {
        props: {
          source: sourceOf(`nostr:${NOTE}`),
          depth: 1,
          embeds: quoted(`hi nostr:${NPUB}`),
          authorAction: AUTHOR,
          onAction,
        },
      });

      await fireEvent.click(screen.getByRole('button', { name: /npub10elf/ }));

      const [, context] = onAction.mock.calls[0];
      // The person mentioned, on the post that mentions them.
      expect(context.pubkey).toBe(NPUB_HEX);
      expect(context.event.id).toBe(NOTE_HEX);
    });
  });

  it('renders a chip for a reference that names a person', () => {
    const onEmbedRequest = vi.fn();
    const { container } = render(EmbeddedNote, {
      props: { source: sourceOf(`nostr:${NPUB}`), depth: 1, onEmbedRequest },
    });

    expect(container.querySelector('.quote')).toBeNull();
    expect(onEmbedRequest).not.toHaveBeenCalled();
  });
});
