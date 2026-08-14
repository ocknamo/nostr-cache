// @vitest-environment jsdom
import type { NostrEvent } from '@nostr-cache/shared';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { EventAction } from '../lib/event-actions.ts';
import { parsePostTarget } from '../lib/post-target.ts';
import type { TimelineState } from '../lib/timeline-controller.ts';
import { makeEvent } from '../test-fixtures.ts';
import PostView from './PostView.svelte';

const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const ALICE = 'bb0000000000000000000000000000000000000000000000000000000000000b';

const TARGET = parsePostTarget({ eventId: POST_ID });

function state(overrides: Partial<TimelineState> = {}): TimelineState {
  return {
    status: 'connected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    embeds: new Map(),
    reactions: new Map(),
    eose: false,
    ...overrides,
  };
}

/** A kind 7 on the post, from `pubkey`, carrying `content`. */
function reaction(pubkey: string, content: string, id: string): NostrEvent {
  return makeEvent({ id, pubkey, kind: 7, content, tags: [['e', POST_ID]] });
}

const POST = makeEvent({ id: POST_ID, pubkey: ALICE, content: 'the post' });

describe('PostView', () => {
  it('says so when the element was given no post to show', () => {
    render(PostView, { props: { state: state(), target: undefined } });

    expect(screen.getByText('表示する投稿が指定されていません')).toBeInTheDocument();
  });

  it('waits before concluding the post does not exist', () => {
    render(PostView, { props: { state: state(), target: TARGET } });

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('reports a post the relay does not have, once EOSE has arrived', () => {
    render(PostView, { props: { state: state({ eose: true }), target: TARGET } });

    expect(screen.getByText('投稿が見つかりませんでした')).toBeInTheDocument();
  });

  it('renders the post once it arrives', () => {
    render(PostView, { props: { state: state({ events: [POST] }), target: TARGET } });

    expect(screen.getByText('the post')).toBeInTheDocument();
  });

  it('keeps the post on screen while the relay reconnects', () => {
    render(PostView, {
      props: { state: state({ events: [POST], status: 'reconnecting' }), target: TARGET },
    });

    // Above the post rather than replacing it, so it stays readable.
    expect(screen.getByText('リレーに再接続しています…')).toBeInTheDocument();
    expect(screen.getByText('the post')).toBeInTheDocument();
  });

  it('renders a fatal error instead of everything else', () => {
    render(PostView, {
      props: { state: state({ events: [POST] }), target: TARGET, fatal: '設定が壊れています' },
    });

    expect(screen.getByText('設定が壊れています')).toBeInTheDocument();
    expect(screen.queryByText('the post')).not.toBeInTheDocument();
  });

  it('reports a press to the action and to the element, exactly as a card does', async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    const action: EventAction = { id: 'like', label: 'いいね', icon: '❤', onSelect };

    render(PostView, {
      props: {
        state: state({ events: [POST], validationStatuses: new Map([[POST_ID, 'validated']]) }),
        target: TARGET,
        actions: [action],
        onAction,
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'いいね' }));

    expect(onSelect).toHaveBeenCalledWith({ event: POST, status: 'validated' });
    expect(onAction).toHaveBeenCalledWith(action, { event: POST, status: 'validated' });
  });

  it('counts the reactions the controller collected', () => {
    render(PostView, {
      props: {
        state: state({
          events: [POST],
          reactions: new Map([
            [
              POST_ID,
              [reaction('p1', '+', 'r1'), reaction('p2', '+', 'r2'), reaction('p3', '🔥', 'r3')],
            ],
          ]),
        }),
        target: TARGET,
      },
    });

    expect(screen.getByRole('button', { name: /❤️ 2 件/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /🔥 1 件/ })).toBeInTheDocument();
  });

  it('hides the reaction bar when the element turned reactions off', () => {
    render(PostView, {
      props: {
        state: state({
          events: [POST],
          reactions: new Map([[POST_ID, [reaction('p1', '+', 'r1')]]]),
        }),
        target: TARGET,
        showReactions: false,
      },
    });

    expect(screen.queryByRole('button', { name: /❤️/ })).not.toBeInTheDocument();
  });

  it('asks for the author profile when the post appears', () => {
    const onAuthorVisible = vi.fn();

    render(PostView, {
      props: { state: state({ events: [POST] }), target: TARGET, onAuthorVisible },
    });

    expect(onAuthorVisible).toHaveBeenCalledWith(ALICE);
  });
});
