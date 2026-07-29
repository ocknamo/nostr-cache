// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { EventOrigin } from '../lib/cache-metrics.ts';
import Timeline from './Timeline.svelte';
import { makeEvent } from './test-fixtures.ts';

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
});
