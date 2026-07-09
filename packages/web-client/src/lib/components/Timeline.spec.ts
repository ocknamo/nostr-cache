// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Timeline from './Timeline.svelte';
import { makeEvent } from './test-fixtures.ts';

describe('Timeline', () => {
  it('shows the loading message before EOSE when there are no events', () => {
    render(Timeline, { props: { events: [], eose: false } });
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('shows the empty message after EOSE when there are no events', () => {
    render(Timeline, { props: { events: [], eose: true } });
    expect(
      screen.getByText('イベントはまだありません。投稿するかフィルタを変更してください。')
    ).toBeInTheDocument();
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

  it('passes the per-event validation status down to the card badge', () => {
    const events = [makeEvent({ id: 'a', content: 'verified note' })];
    const validationStatuses = new Map([['a', 'validated' as const]]);
    render(Timeline, { props: { events, eose: true, validationStatuses } });

    expect(screen.getByLabelText('署名検証済み')).toBeInTheDocument();
  });
});
