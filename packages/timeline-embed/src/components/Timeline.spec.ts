// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { EventOrigin } from '../lib/cache-metrics.ts';
import type { Profile } from '../lib/profile.ts';
import { makeEvent } from '../test-fixtures.ts';
import Timeline from './Timeline.svelte';

describe('Timeline', () => {
  it('shows the loading message before EOSE when there are no events', () => {
    render(Timeline, { props: { events: [] } });

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('shows the empty message once EOSE confirms there is nothing to show', () => {
    render(Timeline, { props: { events: [], eose: true } });

    expect(screen.getByText('イベントがありません')).toBeInTheDocument();
  });

  it('renders one card per event', () => {
    const events = [
      makeEvent({ id: 'a', content: 'first' }),
      makeEvent({ id: 'b', content: 'second' }),
    ];
    render(Timeline, { props: { events, eose: true } });

    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('passes each event its own origin badge', () => {
    const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' })];
    const origins = new Map<string, EventOrigin>([
      ['a', 'cache'],
      ['b', 'upstream'],
    ]);
    render(Timeline, { props: { events, origins, eose: true } });

    expect(screen.getByText('cache')).toBeInTheDocument();
    expect(screen.getByText('upstream')).toBeInTheDocument();
  });

  it('hides origin badges when showOrigin is false', () => {
    const events = [makeEvent({ id: 'a' })];
    const origins = new Map<string, EventOrigin>([['a', 'cache']]);
    render(Timeline, { props: { events, origins, showOrigin: false, eose: true } });

    expect(screen.queryByText('cache')).not.toBeInTheDocument();
  });

  it('passes validation statuses through to the cards', () => {
    const events = [makeEvent({ id: 'a' })];
    const validationStatuses = new Map<string, 'validated'>([['a', 'validated']]);
    render(Timeline, { props: { events, validationStatuses, eose: true } });

    expect(screen.getByLabelText('署名検証済み')).toBeInTheDocument();
  });

  it('gives each card the profile of its own author', () => {
    const events = [makeEvent({ id: 'a', pubkey: 'alice' }), makeEvent({ id: 'b', pubkey: 'bob' })];
    const profiles = new Map<string, Profile>([
      ['alice', { displayName: 'アリス' }],
      ['bob', { displayName: 'ボブ' }],
    ]);
    render(Timeline, { props: { events, profiles, eose: true } });

    expect(screen.getByText('アリス')).toBeInTheDocument();
    expect(screen.getByText('ボブ')).toBeInTheDocument();
  });

  it('leaves an author without a profile on their shortened pubkey', () => {
    const events = [makeEvent({ id: 'a', pubkey: 'pk'.padEnd(64, '0') })];
    render(Timeline, { props: { events, profiles: new Map<string, Profile>(), eose: true } });

    expect(screen.getByText('pk000000…00000000')).toBeInTheDocument();
  });

  it('reports the author of each card that becomes visible', () => {
    const events = [makeEvent({ id: 'a', pubkey: 'alice' }), makeEvent({ id: 'b', pubkey: 'bob' })];
    const onAuthorVisible = vi.fn();

    // jsdom has no IntersectionObserver, so EventCard reports straight away —
    // which is exactly the path this asserts: the right pubkey per card.
    render(Timeline, { props: { events, onAuthorVisible, eose: true } });

    expect(onAuthorVisible.mock.calls.map(([pubkey]) => pubkey)).toEqual(['alice', 'bob']);
  });

  it('hides avatars when showAvatars is false', () => {
    const events = [makeEvent({ id: 'a', pubkey: 'alice' })];
    const profiles = new Map<string, Profile>([
      ['alice', { name: 'alice', picture: 'https://example.com/a.png' }],
    ]);
    render(Timeline, { props: { events, profiles, showAvatars: false, eose: true } });

    expect(screen.queryByRole('img', { name: 'alice' })).not.toBeInTheDocument();
  });

  it('hides note attachments when showMedia is false', () => {
    const events = [makeEvent({ id: 'a', content: 'https://cdn.example.com/a.jpg' })];
    const { container } = render(Timeline, {
      props: { events, showMedia: false, showAvatars: false, eose: true },
    });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'https://cdn.example.com/a.jpg' })).toBeInTheDocument();
  });

  it('puts the same action bar under every card, each pressing with its own event', async () => {
    const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' })];
    const onAction = vi.fn();
    const actions = [{ id: 'like', label: 'いいね', icon: '♡' }];
    render(Timeline, { props: { events, actions, onAction, eose: true } });

    const buttons = screen.getAllByRole('button', { name: 'いいね' });
    expect(buttons).toHaveLength(2);

    await fireEvent.click(buttons[1]);
    expect(onAction).toHaveBeenCalledWith(actions[0], { event: events[1] });
  });

  it('flips only the first card date tooltip downward', async () => {
    const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' })];
    const { container } = render(Timeline, { props: { events, eose: true } });

    for (const toggle of screen.getAllByRole('button', { name: '日付を表示' })) {
      await fireEvent.click(toggle);
    }

    // The list no longer reserves a tooltip's worth of space above the first
    // card, so that one opens under its header instead; the rest are unchanged.
    const tips = [...container.querySelectorAll('.date-tip')];
    expect(tips).toHaveLength(2);
    expect(tips[0]).toHaveClass('below');
    expect(tips[1]).not.toHaveClass('below');
  });

  it('lets a card name a mention using another author on the timeline', () => {
    const mentioned = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
    const events = [makeEvent({ id: 'a', pubkey: 'alice', content: `hi nostr:${npub}` })];
    const profiles = new Map<string, Profile>([
      ['alice', { displayName: 'アリス' }],
      [mentioned, { displayName: 'たけし' }],
    ]);
    render(Timeline, { props: { events, profiles, eose: true } });

    expect(screen.getByText('@たけし')).toBeInTheDocument();
  });

  /**
   * The trigger itself is `IntersectionObserver`, which jsdom does not
   * implement — `whileVisible` reports nothing there, so what these pin down is
   * everything around it: when the end is watched at all, and what it says.
   */
  describe('paging the end of the list', () => {
    const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' })];

    it('watches the end only when the embedder asked for paging', () => {
      const { container } = render(Timeline, { props: { events, eose: true } });
      expect(container.querySelector('.sentinel')).toBeNull();

      const paging = render(Timeline, {
        props: { events, eose: true, onReachEnd: () => {} },
      });
      expect(paging.container.querySelector('.sentinel')).not.toBeNull();
    });

    it('has nothing to watch while the timeline is still empty', () => {
      const { container } = render(Timeline, { props: { events: [], onReachEnd: () => {} } });

      expect(container.querySelector('.sentinel')).toBeNull();
    });

    it('says a page is on its way, in words the empty state does not use', () => {
      render(Timeline, {
        props: { events, eose: true, loadingOlder: true, onReachEnd: () => {} },
      });

      expect(screen.getByText('さらに読み込んでいます…')).toBeInTheDocument();
      expect(screen.queryByText('読み込み中…')).toBeNull();
    });

    it('says nothing once the timeline has run out', () => {
      const { container } = render(Timeline, {
        props: { events, eose: true, exhausted: true, onReachEnd: () => {} },
      });

      expect(container.querySelector('.loading-more')).toBeNull();
    });
  });
});
