// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { type EntityPart, parseContent } from '../lib/content-parts.ts';
import type { EmbeddedEvent } from '../lib/note-embeds.ts';
import type { Profile } from '../lib/profile.ts';
import { makeEvent } from '../test-fixtures.ts';
import EmbeddedNote from './EmbeddedNote.svelte';

const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
/** A second quotable event, so a quote can quote something. */
const OTHER_NOTE = 'note1424242424242424242424242424242424242424242424242424qv3q9y6';
const OTHER_NOTE_HEX = 'aa'.repeat(32);

/** The entity a one-reference body parses to. */
function entityOf(content: string): EntityPart {
  const part = parseContent(content).find((candidate) => candidate.kind === 'entity');
  if (!part) {
    throw new Error(`no entity in ${content}`);
  }
  return part;
}

/** A resolved quote of `content`, keyed the way the controller keys it. */
function ready(key: string, content: string, id = key): Map<string, EmbeddedEvent> {
  return new Map([[key, { status: 'ready', event: makeEvent({ id, content }) }]]);
}

describe('EmbeddedNote', () => {
  it('asks for the referenced event when it appears', () => {
    const onEmbedRequest = vi.fn();
    render(EmbeddedNote, {
      props: { entity: entityOf(`nostr:${NOTE}`), depth: 1, onEmbedRequest },
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
        entity: entityOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'loading' }]]),
      },
    });

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('falls back to the abbreviated chip when nothing came back', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        entity: entityOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'missing' }]]),
      },
    });

    // No frame: one would claim there is a post here.
    expect(container.querySelector('.quote')).toBeNull();
    expect(screen.getByTitle(`nostr:${NOTE}`)).toHaveTextContent('note1tszz…elrl');
  });

  it('renders the quoted body inside a frame', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        entity: entityOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: ready(NOTE_HEX, 'quoted body'),
      },
    });

    expect(container.querySelector('.quote')).not.toBeNull();
    expect(container.querySelector('.content')).toHaveTextContent('quoted body');
  });

  it('puts the avatar in the header row rather than in a column of its own', () => {
    // The whole point of the component: the body must not be indented past the
    // avatar, so nesting does not narrow it level by level.
    const { container } = render(EmbeddedNote, {
      props: {
        entity: entityOf(`nostr:${NOTE}`),
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
        entity: entityOf(`nostr:${NOTE}`),
        depth: 1,
        embeds: new Map<string, EmbeddedEvent>([[NOTE_HEX, { status: 'ready', event }]]),
        profiles,
      },
    });

    expect(screen.getByText('たけし')).toBeInTheDocument();
  });

  it('fades a quote the relay has not vouched for, and stops once it has', () => {
    const props = {
      entity: entityOf(`nostr:${NOTE}`),
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
        entity: entityOf(`nostr:${NOTE}`),
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
        entity: entityOf(`nostr:${NOTE}`),
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
        entity: entityOf(`nostr:${NOTE}`),
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

  it('stops nesting at the depth cap, leaving the reference as a chip', () => {
    const { container } = render(EmbeddedNote, {
      props: {
        // Depth 5 is the last card that is drawn, so its own references stay
        // in its text rather than opening a sixth level.
        entity: entityOf(`nostr:${NOTE}`),
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

  it('renders a chip for a reference that names a person', () => {
    const onEmbedRequest = vi.fn();
    const { container } = render(EmbeddedNote, {
      props: { entity: entityOf(`nostr:${NPUB}`), depth: 1, onEmbedRequest },
    });

    expect(container.querySelector('.quote')).toBeNull();
    expect(onEmbedRequest).not.toHaveBeenCalled();
  });
});
