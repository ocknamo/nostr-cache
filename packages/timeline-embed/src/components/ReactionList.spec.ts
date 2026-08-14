// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../lib/profile.ts';
import type { Reaction } from '../lib/reactions.ts';
import ReactionList from './ReactionList.svelte';

const ALICE = 'aa0000000000000000000000000000000000000000000000000000000000000a';
const BOB = 'bb0000000000000000000000000000000000000000000000000000000000000b';

function reactor(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: 'r1',
    pubkey: ALICE,
    createdAt: 1000,
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
