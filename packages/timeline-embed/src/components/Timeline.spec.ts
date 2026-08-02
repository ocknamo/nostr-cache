// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
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
});
