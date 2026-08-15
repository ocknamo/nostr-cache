import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import type { PostTargetMatch } from './post-target.ts';
import { type ReplyNode, acceptsReply, buildReplyTree } from './reply-tree.ts';

const POST = 'a'.repeat(64);
const OTHER = 'f'.repeat(64);
const ADDRESS = `30023:${'b'.repeat(64)}:my-article`;

const AT_POST: PostTargetMatch = { id: POST };
const AT_ADDRESS: PostTargetMatch = { address: ADDRESS };

/**
 * A hex id per name, so a fixture can be written as the tree it describes.
 * Assigned in first-seen order; tests that care about id ordering spell the
 * ids out instead.
 */
const ids = new Map<string, string>();
function id(name: string): string {
  const known = ids.get(name);
  if (known !== undefined) {
    return known;
  }
  const value = (ids.size + 1).toString(16).padStart(64, '0');
  ids.set(name, value);
  return value;
}

/** A reply in the marked form, which is what a NIP-10 client writes. */
function reply(name: string, parent: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return makeEvent({
    id: id(name),
    content: name,
    tags:
      parent === POST
        ? [['e', POST, '', 'root']]
        : [
            ['e', POST, '', 'root'],
            ['e', parent, '', 'reply'],
          ],
    ...overrides,
  });
}

/** `name` of every event in the tree, depth-first, as `parent > child`. */
function paths(nodes: readonly ReplyNode[], prefix = ''): string[] {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix} > ${node.event.content}` : node.event.content;
    return [path, ...paths(node.children, path)];
  });
}

describe('acceptsReply', () => {
  it('takes a kind 1 that names a parent', () => {
    expect(acceptsReply(reply('r1', POST), AT_POST)).toBe(true);
  });

  it('rejects a reaction delivered by the same #e filter', () => {
    const reaction = makeEvent({ kind: 7, content: '+', tags: [['e', POST]] });

    expect(acceptsReply(reaction, AT_POST)).toBe(false);
  });

  it('rejects a note that only mentions the post', () => {
    const mention = makeEvent({ id: id('m1'), tags: [['e', POST, '', 'mention']] });

    expect(acceptsReply(mention, AT_POST)).toBe(false);
  });

  it('rejects the post itself, which its own #e subscription delivers', () => {
    expect(acceptsReply(makeEvent({ id: POST, tags: [['e', OTHER]] }), AT_POST)).toBe(false);
  });
});

describe('buildReplyTree', () => {
  it('nests replies under the event each one answers', () => {
    const events = [reply('r1', POST), reply('r2', id('r1')), reply('r3', id('r2'))];

    const tree = buildReplyTree(events, AT_POST);

    expect(paths(tree.roots)).toEqual(['r1', 'r1 > r2', 'r1 > r2 > r3']);
    expect(tree.total).toBe(3);
    expect(tree.orphans).toBe(0);
  });

  it('reads the deprecated positional form, where the last e tag is the parent', () => {
    const events = [
      makeEvent({ id: id('r1'), content: 'r1', tags: [['e', POST]] }),
      makeEvent({
        id: id('r2'),
        content: 'r2',
        tags: [
          ['e', POST],
          ['e', id('r1')],
        ],
      }),
    ];

    expect(paths(buildReplyTree(events, AT_POST).roots)).toEqual(['r1', 'r1 > r2']);
  });

  it('drops a reply whose parent never arrived, and says how many', () => {
    // What a sibling branch of the same thread looks like: the relay matched it
    // on the root `e` tag, but its parent is not in this post's subtree.
    const events = [reply('r1', POST), reply('stray', OTHER)];

    const tree = buildReplyTree(events, AT_POST);

    expect(paths(tree.roots)).toEqual(['r1']);
    expect(tree.orphans).toBe(1);
  });

  it('drops an event that names itself as its parent', () => {
    const selfish = makeEvent({ id: id('r1'), content: 'r1', tags: [['e', id('r1')]] });

    const tree = buildReplyTree([selfish], AT_POST);

    expect(tree.roots).toEqual([]);
    expect(tree.orphans).toBe(1);
  });

  it('terminates on a cycle rather than following it', () => {
    const a = makeEvent({ id: id('a'), content: 'a', tags: [['e', id('b')]] });
    const b = makeEvent({ id: id('b'), content: 'b', tags: [['e', id('a')]] });

    const tree = buildReplyTree([a, b, reply('r1', POST)], AT_POST);

    expect(paths(tree.roots)).toEqual(['r1']);
    expect(tree.orphans).toBe(2);
  });

  it('orders siblings oldest first, whatever order they were delivered in', () => {
    const events = [
      reply('late', POST, { created_at: 1_700_000_300 }),
      reply('early', POST, { created_at: 1_700_000_100 }),
      reply('middle', POST, { created_at: 1_700_000_200 }),
    ];

    expect(paths(buildReplyTree(events, AT_POST).roots)).toEqual(['early', 'middle', 'late']);
    expect(paths(buildReplyTree([...events].reverse(), AT_POST).roots)).toEqual([
      'early',
      'middle',
      'late',
    ]);
  });

  it('breaks a timestamp tie by id, so the order is not delivery order', () => {
    const bigger = makeEvent({ id: 'e'.repeat(64), content: 'bigger', tags: [['e', POST]] });
    const smaller = makeEvent({ id: 'b'.repeat(64), content: 'smaller', tags: [['e', POST]] });

    expect(paths(buildReplyTree([bigger, smaller], AT_POST).roots)).toEqual(['smaller', 'bigger']);
  });

  it('keeps one node for a duplicate delivery', () => {
    const once = reply('r1', POST);

    const tree = buildReplyTree([once, { ...once }], AT_POST);

    expect(tree.total).toBe(1);
    expect(tree.orphans).toBe(0);
  });

  it('stops at maxDepth and marks the node whose children were cut', () => {
    const events = [reply('r1', POST), reply('r2', id('r1')), reply('r3', id('r2'))];

    const tree = buildReplyTree(events, AT_POST, { maxDepth: 2 });

    expect(paths(tree.roots)).toEqual(['r1', 'r1 > r2']);
    expect(tree.roots[0].children[0].hiddenChildren).toBe(1);
    expect(tree.hidden).toBe(1);
    // The cut is not a failure to connect; nothing was orphaned here.
    expect(tree.orphans).toBe(0);
  });

  it('counts a whole cut subtree as hidden rather than orphaned', () => {
    const events = [
      reply('r1', POST),
      reply('r2', id('r1')),
      reply('r3', id('r2')),
      reply('r4', id('r3')),
    ];

    const tree = buildReplyTree(events, AT_POST, { maxDepth: 1 });

    expect(tree.total).toBe(1);
    expect(tree.hidden).toBe(3);
    expect(tree.orphans).toBe(0);
  });

  it('spends the node cap on the shallow replies before a deep branch', () => {
    const events = [
      reply('r1', POST, { created_at: 1_700_000_100 }),
      reply('deep', id('r1'), { created_at: 1_700_000_150 }),
      reply('r2', POST, { created_at: 1_700_000_200 }),
    ];

    const tree = buildReplyTree(events, AT_POST, { maxNodes: 2 });

    expect(paths(tree.roots)).toEqual(['r1', 'r2']);
    expect(tree.roots[0].hiddenChildren).toBe(1);
    expect(tree.hidden).toBe(1);
  });

  it('hangs a reply to an addressable post under its coordinate', () => {
    const direct = makeEvent({
      id: id('r1'),
      content: 'r1',
      tags: [['a', ADDRESS, '', 'root']],
    });
    const nested = makeEvent({
      id: id('r2'),
      content: 'r2',
      tags: [
        ['a', ADDRESS, '', 'root'],
        ['e', id('r1'), '', 'reply'],
      ],
    });
    const elsewhere = makeEvent({
      id: id('r3'),
      content: 'r3',
      tags: [['a', `30023:${'b'.repeat(64)}:other`, '', 'root']],
    });

    const tree = buildReplyTree([direct, nested, elsewhere], AT_ADDRESS);

    expect(paths(tree.roots)).toEqual(['r1', 'r1 > r2']);
    expect(tree.orphans).toBe(1);
  });

  it('has nothing to build without a target', () => {
    expect(buildReplyTree([reply('r1', POST)], {})).toEqual({
      roots: [],
      total: 0,
      hidden: 0,
      orphans: 0,
    });
  });
});
