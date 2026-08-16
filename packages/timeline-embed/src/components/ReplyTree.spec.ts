// @vitest-environment jsdom
import type { NostrEvent } from '@nostr-cache/shared';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { buildReplyTree } from '../lib/reply-tree.ts';
import { makeEvent } from '../test-fixtures.ts';
import ReplyTree from './ReplyTree.svelte';

const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const REPLY_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';
const GRANDCHILD_ID = 'cc00000000000000000000000000000000000000000000000000000000000003';
const SIBLING_ID = 'dd00000000000000000000000000000000000000000000000000000000000004';

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

/** Built through the real builder, so the view and the rules cannot drift. */
function tree(events: NostrEvent[], options: { maxDepth?: number; maxNodes?: number } = {}) {
  return buildReplyTree(events, { id: POST_ID }, options);
}

describe('ReplyTree', () => {
  it('renders nothing when the post has no replies', () => {
    const { container } = render(ReplyTree, { props: { tree: tree([]) } });

    expect(container.querySelector('.replies')).toBeNull();
  });

  it('counts the replies it placed', () => {
    render(ReplyTree, {
      props: {
        tree: tree([
          reply(REPLY_ID, POST_ID, 'first'),
          reply(SIBLING_ID, POST_ID, 'second'),
          reply(GRANDCHILD_ID, REPLY_ID, 'under the first'),
        ]),
      },
    });

    expect(screen.getByText('返信 3 件')).toBeInTheDocument();
  });

  it('nests a reply inside the one it answers', () => {
    const { container } = render(ReplyTree, {
      props: {
        tree: tree([reply(REPLY_ID, POST_ID, 'first'), reply(GRANDCHILD_ID, REPLY_ID, 'nested')]),
      },
    });

    // Depth is the nesting, not a class per level, so this is what "nested"
    // means for the indent rule too.
    const branches = container.querySelectorAll('.branch');
    expect(branches).toHaveLength(2);
    expect(branches[0].contains(branches[1])).toBe(true);
    expect(branches[1].textContent).toContain('nested');
    expect(branches[1].textContent).not.toContain('first');
  });

  it('marks a reply whose own replies were left out by the depth cap', () => {
    render(ReplyTree, {
      props: {
        tree: tree([reply(REPLY_ID, POST_ID, 'first'), reply(GRANDCHILD_ID, REPLY_ID, 'nested')], {
          maxDepth: 1,
        }),
      },
    });

    expect(screen.queryByText('nested')).not.toBeInTheDocument();
    expect(screen.getByText(/さらに 1 件の返信があります/)).toBeInTheDocument();
  });

  it('drops the 返信先 chip, which the nesting already says', () => {
    const onEmbedRequest = vi.fn();
    const { container } = render(ReplyTree, {
      props: {
        tree: tree([reply(REPLY_ID, POST_ID, 'first'), reply(GRANDCHILD_ID, REPLY_ID, 'nested')]),
        onEmbedRequest,
      },
    });

    expect(container.querySelector('.ref')).toBeNull();
    // No chip is also no lookup: a thread of 50 replies must not ask the relay
    // for 50 parents it is already showing.
    expect(onEmbedRequest).not.toHaveBeenCalled();
  });

  it('says so when the node cap left direct replies out', () => {
    render(ReplyTree, {
      props: {
        tree: tree([reply(REPLY_ID, POST_ID, 'first'), reply(SIBLING_ID, POST_ID, 'second')], {
          maxNodes: 1,
        }),
      },
    });

    // There is no card at the top level to hang 「さらに N 件」 off, so without
    // this the cap removes replies with nothing on screen to say it happened.
    expect(screen.getByText(/他に 1 件の返信がありますが、表示していません/)).toBeInTheDocument();
  });

  it('renders no action buttons under a reply', () => {
    const { container } = render(ReplyTree, {
      props: { tree: tree([reply(REPLY_ID, POST_ID, 'first')]) },
    });

    // `actions` is what the page declared for the post it named; repeating that
    // row under every reply turns one control into a column of them.
    expect(container.querySelector('.actions')).toBeNull();
  });

  it('asks for a reply author profile when the card appears', () => {
    const seen: string[] = [];

    render(ReplyTree, {
      props: {
        tree: tree([reply(REPLY_ID, POST_ID, 'first')]),
        onAuthorVisible: (pubkey: string) => seen.push(pubkey),
      },
    });

    expect(seen).toEqual([`pk${REPLY_ID}`]);
  });
});
