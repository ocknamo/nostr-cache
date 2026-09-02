// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../lib/profile.ts';
import type { Reaction } from '../lib/reactions.ts';
import { makeEvent } from '../test-fixtures.ts';
import ReactionList from './ReactionList.svelte';

const ALICE = 'aa0000000000000000000000000000000000000000000000000000000000000a';
const BOB = 'bb0000000000000000000000000000000000000000000000000000000000000b';

function reactor(overrides: Partial<Reaction> = {}): Reaction {
  const id = overrides.id ?? 'r1';
  const pubkey = overrides.pubkey ?? ALICE;
  return {
    id,
    pubkey,
    createdAt: 1000,
    event: makeEvent({ id, pubkey, kind: 7, content: '🔥' }),
    kind: 'emoji',
    key: '🔥',
    label: '🔥',
    ...overrides,
  };
}

describe('ReactionList', () => {
  it('shows who reacted and what they sent', () => {
    const profiles = new Map<string, Profile>([[ALICE, { displayName: 'Alice' }]]);

    render(ReactionList, { props: { reactors: [reactor()], profiles } });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('🔥')).toBeInTheDocument();
  });

  it('serves a reactor avatar through the image proxy', () => {
    const profiles = new Map<string, Profile>([
      [ALICE, { displayName: 'Alice', picture: 'https://example.com/a.png' }],
    ]);

    const { container } = render(ReactionList, {
      props: { reactors: [reactor()], profiles, imageProxy: 'https://optimizer.example/image' },
    });

    // The list is the deepest place an avatar is rendered, and so the easiest
    // one for the attribute to stop short of.
    expect(container.querySelector('img.avatar')).toHaveAttribute(
      'src',
      'https://optimizer.example/image/width=96,quality=70,format=webp/https://example.com/a.png'
    );
  });

  it('falls back to a shortened pubkey while the profile has not arrived', () => {
    render(ReactionList, { props: { reactors: [reactor()] } });

    expect(screen.getByText('aa000000…0000000a')).toBeInTheDocument();
  });

  it('renders a custom emoji as an image', () => {
    render(ReactionList, {
      props: {
        reactors: [
          reactor({ kind: 'custom', key: ':x:', label: ':x:', url: 'https://e.test/x.png' }),
        ],
      },
    });

    expect(screen.getByRole('img', { name: ':x:' })).toHaveAttribute('src', 'https://e.test/x.png');
  });

  describe('reactor press', () => {
    const AUTHOR = { id: 'open-profile', label: 'プロフィールを開く' };

    it('leaves the row plain until an embedder asks for the press', () => {
      const { container } = render(ReactionList, {
        props: { reactors: [reactor()], onAuthorPress: vi.fn() },
      });

      expect(container.querySelector('button')).toBeNull();
    });

    it('reports the reactor and the kind 7 their row stands for', async () => {
      const onAuthorPress = vi.fn();
      const profiles = new Map<string, Profile>([[ALICE, { displayName: 'Alice' }]]);
      render(ReactionList, {
        props: { reactors: [reactor()], profiles, authorAction: AUTHOR, onAuthorPress },
      });

      await fireEvent.click(screen.getByRole('button', { name: 'プロフィールを開く: Alice' }));

      expect(onAuthorPress).toHaveBeenCalledTimes(1);
      const [pubkey, event] = onAuthorPress.mock.calls[0];
      expect(pubkey).toBe(ALICE);
      expect(event).toMatchObject({ id: 'r1', kind: 7 });
    });

    it('leaves the glyph outside the press: it is not somewhere to go', () => {
      const { container } = render(ReactionList, {
        props: { reactors: [reactor()], authorAction: AUTHOR, onAuthorPress: vi.fn() },
      });

      expect(container.querySelector('.reactor-author .glyph')).toBeNull();
      expect(container.querySelector('.reactor > .glyph')).not.toBeNull();
    });
  });

  it('asks for a reactor profile when their row appears', () => {
    // jsdom has no IntersectionObserver, so `whenVisible` reports immediately.
    const onReactorVisible = vi.fn();

    render(ReactionList, {
      props: { reactors: [reactor(), reactor({ id: 'r2', pubkey: BOB })], onReactorVisible },
    });

    expect(onReactorVisible).toHaveBeenCalledWith(ALICE);
    expect(onReactorVisible).toHaveBeenCalledWith(BOB);
  });

  it('drops the avatars but keeps the names when asked', () => {
    const profiles = new Map<string, Profile>([
      [ALICE, { displayName: 'Alice', picture: 'https://e.test/a.png' }],
    ]);

    render(ReactionList, { props: { reactors: [reactor()], profiles, showAvatars: false } });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
