// @vitest-environment jsdom
import type { NostrEvent } from '@nostr-cache/shared';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventAction } from '../lib/event-actions.ts';
import { resetOgpCache } from '../lib/ogp.ts';
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
    replies: new Map(),
    eose: false,
    ...overrides,
  };
}

/** A kind 7 on the post, from `pubkey`, carrying `content`. */
function reaction(pubkey: string, content: string, id: string): NostrEvent {
  return makeEvent({ id, pubkey, kind: 7, content, tags: [['e', POST_ID]] });
}

const PARENT_ID = 'cc0000000000000000000000000000000000000000000000000000000000000c';
const REPLY_ID = 'dd00000000000000000000000000000000000000000000000000000000000001';
const GRANDCHILD_ID = 'dd00000000000000000000000000000000000000000000000000000000000002';

/** A NIP-10 reply in the marked form. */
function reply(id: string, parent: string, content: string): NostrEvent {
  return makeEvent({
    id,
    pubkey: `pk${id}`,
    content,
    tags:
      parent === POST_ID
        ? [['e', POST_ID, '', 'root']]
        : [
            ['e', POST_ID, '', 'root'],
            ['e', parent, '', 'reply'],
          ],
  });
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

  describe('the thread', () => {
    const THREAD = new Map([
      [
        POST_ID,
        [
          reply(REPLY_ID, POST_ID, 'a reply'),
          reply(GRANDCHILD_ID, REPLY_ID, 'a reply to the reply'),
        ],
      ],
    ]);

    it('renders the replies nested under the post', () => {
      render(PostView, {
        props: { state: state({ events: [POST], replies: THREAD }), target: TARGET },
      });

      expect(screen.getByText('返信 2 件')).toBeInTheDocument();
      expect(screen.getByText('a reply')).toBeInTheDocument();
      expect(screen.getByText('a reply to the reply')).toBeInTheDocument();
    });

    it('makes every reply author pressable, not only the post author', async () => {
      const onAction = vi.fn();
      const authorAction = { id: 'open-profile', label: 'プロフィールを開く' };
      const { container } = render(PostView, {
        props: {
          state: state({ events: [POST], replies: THREAD }),
          target: TARGET,
          authorAction,
          onAction,
        },
      });

      // The post and both replies: unlike `actions`, this adds no row to a card,
      // and a thread is mostly other people.
      const authors = container.querySelectorAll<HTMLButtonElement>('button[part="author"]');
      expect(authors).toHaveLength(3);

      await fireEvent.click(authors[2]);

      expect(onAction).toHaveBeenCalledWith(
        authorAction,
        expect.objectContaining({ pubkey: reply(GRANDCHILD_ID, REPLY_ID, '').pubkey })
      );
    });

    it('renders nothing at all for a post with no replies', () => {
      render(PostView, {
        props: { state: state({ events: [POST] }), target: TARGET },
      });

      // A heading over an empty list is furniture on a post nobody answered.
      expect(screen.queryByText(/^返信 /)).not.toBeInTheDocument();
    });

    it('hides the thread when the element turned replies off', () => {
      render(PostView, {
        props: {
          state: state({ events: [POST], replies: THREAD }),
          target: TARGET,
          showReplies: false,
        },
      });

      expect(screen.queryByText('a reply')).not.toBeInTheDocument();
    });

    it('renders only as deep as the element subscribed', () => {
      render(PostView, {
        props: {
          state: state({ events: [POST], replies: THREAD }),
          target: TARGET,
          repliesDepth: 1,
        },
      });

      expect(screen.getByText('a reply')).toBeInTheDocument();
      expect(screen.queryByText('a reply to the reply')).not.toBeInTheDocument();
      expect(screen.getByText(/さらに 1 件の返信があります/)).toBeInTheDocument();
    });

    it('says how many replies never connected to the post', () => {
      const orphan = reply(
        'ee00000000000000000000000000000000000000000000000000000000000001',
        PARENT_ID,
        'another branch'
      );

      render(PostView, {
        props: {
          state: state({ events: [POST], replies: new Map([[POST_ID, [orphan]]]) }),
          target: TARGET,
        },
      });

      expect(screen.getByText(/返信先が取得できなかった投稿が 1 件あります/)).toBeInTheDocument();
    });
  });

  describe('link previews', () => {
    const PROXY = 'https://corsproxy.io/';
    /** A post and a reply that both carry an ordinary link. */
    const LINKED = makeEvent({
      id: POST_ID,
      pubkey: ALICE,
      content: 'the post https://example.com/post',
    });
    const LINKED_THREAD = new Map([
      [POST_ID, [reply(REPLY_ID, POST_ID, 'a reply https://example.com/reply')]],
    ]);

    afterEach(() => {
      vi.unstubAllGlobals();
      resetOgpCache();
    });

    function stubProxy() {
      const fetchMock = vi.fn(async (request: string) => ({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        arrayBuffer: async () =>
          new TextEncoder().encode(
            `<!doctype html><html><head><meta property="og:title" content="リンク先の見出し (${request})" /></head></html>`
          ).buffer,
      }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('previews the post itself but leaves the thread alone', async () => {
      const fetchMock = stubProxy();
      const { container } = render(PostView, {
        props: {
          state: state({ events: [LINKED], replies: LINKED_THREAD }),
          target: TARGET,
          ogpProxy: PROXY,
        },
      });

      expect(await screen.findByText(/リンク先の見出し/)).toBeInTheDocument();
      // One card, for the post — a reply's links are context, and previewing
      // each of them would cost one request per reply.
      expect(container.querySelectorAll('[part="ogp"]')).toHaveLength(1);
      const asked = fetchMock.mock.calls.map(([request]) => String(request));
      expect(asked.some((request) => request.includes('%2Freply'))).toBe(false);
    });

    it('asks nobody anything without a proxy', async () => {
      const fetchMock = stubProxy();
      const { container } = render(PostView, {
        props: { state: state({ events: [LINKED], replies: LINKED_THREAD }), target: TARGET },
      });
      await Promise.resolve();

      expect(container.querySelector('[part="ogp"]')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('walking up to an ancestor', () => {
    const CHILD = makeEvent({
      id: POST_ID,
      pubkey: ALICE,
      content: 'the post',
      tags: [['e', PARENT_ID, '', 'reply']],
    });

    it('makes the 返信先 chip a button when there is somewhere to go', async () => {
      const onNavigate = vi.fn();

      render(PostView, {
        props: { state: state({ events: [CHILD] }), target: TARGET, onNavigate },
      });

      await fireEvent.click(screen.getByRole('button', { name: '返信先の投稿を開く' }));

      expect(onNavigate).toHaveBeenCalledWith(PARENT_ID);
    });

    it('leaves the chip as plain text without a handler', () => {
      render(PostView, { props: { state: state({ events: [CHILD] }), target: TARGET } });

      expect(screen.queryByRole('button', { name: '返信先の投稿を開く' })).not.toBeInTheDocument();
    });

    it('previews the ancestor on the chip once it has been fetched', () => {
      const parent = makeEvent({ id: PARENT_ID, pubkey: ALICE, content: '親の投稿' });

      render(PostView, {
        props: {
          state: state({
            events: [CHILD],
            embeds: new Map([[PARENT_ID, { status: 'ready', event: parent }]]),
          }),
          target: TARGET,
          onEmbedRequest: () => {},
        },
      });

      expect(screen.getByText('親の投稿')).toBeInTheDocument();
    });

    it('offers the way back even when the ancestor turns out not to exist', () => {
      const onBack = vi.fn();

      render(PostView, {
        props: { state: state({ eose: true }), target: TARGET, onBack },
      });

      // Exactly the case where the reader most needs it, and there is no card
      // to hang it off.
      expect(screen.getByText('投稿が見つかりませんでした')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '← 元の投稿に戻る' })).toBeInTheDocument();
    });
  });
});
