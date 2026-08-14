// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../lib/profile.ts';
import { type ReactionSummary, summarizeReactions } from '../lib/reactions.ts';
import ReactionBar from './ReactionBar.svelte';

const ALICE = 'aa0000000000000000000000000000000000000000000000000000000000000a';
const BOB = 'bb0000000000000000000000000000000000000000000000000000000000000b';

/** Build a summary the way the view does, so the shapes cannot drift apart. */
function summary(
  entries: Array<{ pubkey: string; key: string; label?: string; url?: string }>
): ReactionSummary {
  return summarizeReactions(
    entries.map((entry, index) => ({
      id: `r${index}`,
      pubkey: entry.pubkey,
      createdAt: 1000 + index,
      kind: 'emoji' as const,
      key: entry.key,
      label: entry.label ?? entry.key,
      ...(entry.url ? { url: entry.url } : {}),
    }))
  );
}

describe('ReactionBar', () => {
  it('shows a chip per reaction with its count, and the total', () => {
    render(ReactionBar, {
      props: {
        summary: summary([
          { pubkey: ALICE, key: '🔥' },
          { pubkey: BOB, key: '🔥' },
          { pubkey: ALICE, key: '❤️' },
        ]),
      },
    });

    expect(screen.getByRole('button', { name: /🔥 2 件/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /❤️ 1 件/ })).toBeInTheDocument();
    expect(screen.getByText('3 件のリアクション')).toBeInTheDocument();
  });

  it('renders nothing at all for a post nobody reacted to', () => {
    const { container } = render(ReactionBar, { props: { summary: summary([]) } });

    // Not an empty bar reading "0" — the reader cannot react from here.
    expect(container.querySelector('.reactions')).toBeNull();
  });

  it('opens the reactors when a chip is pressed, and closes them again', async () => {
    const profiles = new Map<string, Profile>([[ALICE, { displayName: 'Alice' }]]);
    render(ReactionBar, { props: { summary: summary([{ pubkey: ALICE, key: '🔥' }]), profiles } });

    const chip = screen.getByRole('button', { name: /🔥/ });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();

    await fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alice')).toBeInTheDocument();

    await fireEvent.click(chip);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('opens only one chip at a time', async () => {
    const profiles = new Map<string, Profile>([
      [ALICE, { displayName: 'Alice' }],
      [BOB, { displayName: 'Bob' }],
    ]);
    render(ReactionBar, {
      props: {
        summary: summary([
          { pubkey: ALICE, key: '🔥' },
          { pubkey: BOB, key: '❤️' },
        ]),
        profiles,
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: /🔥/ }));
    await fireEvent.click(screen.getByRole('button', { name: /❤️/ }));

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('opens the largest reaction on its own when asked to', () => {
    const profiles = new Map<string, Profile>([[BOB, { displayName: 'Bob' }]]);
    render(ReactionBar, {
      props: {
        summary: summary([
          { pubkey: ALICE, key: '🔥' },
          { pubkey: BOB, key: '❤️' },
          { pubkey: ALICE, key: '❤️' },
        ]),
        profiles,
        defaultOpen: true,
      },
    });

    expect(screen.getByRole('button', { name: /❤️ 2 件/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('keeps a reaction with a space in it out of the part list', () => {
    // Interpolating the key would publish `way` as a part name of its own.
    const { container } = render(ReactionBar, {
      props: { summary: summary([{ pubkey: ALICE, key: 'no way' }]) },
    });

    expect(container.querySelector('.chip')?.getAttribute('part')).toBe('reaction-chip');
    // An ordinary glyph still gets its own hook.
    const plain = render(ReactionBar, {
      props: { summary: summary([{ pubkey: BOB, key: '🔥' }]) },
    });
    expect(plain.container.querySelector('.chip')?.getAttribute('part')).toBe(
      'reaction-chip reaction-chip-🔥'
    );
  });

  it('renders a custom emoji chip as an image', () => {
    render(ReactionBar, {
      props: {
        summary: summary([{ pubkey: ALICE, key: ':x:', url: 'https://e.test/x.png' }]),
      },
    });

    expect(screen.getByRole('img', { name: ':x:' })).toHaveAttribute('src', 'https://e.test/x.png');
  });
});
