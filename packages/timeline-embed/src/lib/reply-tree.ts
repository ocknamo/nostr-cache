/**
 * Arranges the kind 1 events collected for a post into the thread under it.
 *
 * Pure, like `reactions.ts`: every rule below is testable without booting a
 * relay, and the subscriptions that feed it live in `timeline/reply-watcher.ts`.
 *
 * The tree is grown **downwards from the root**, and only onto events already
 * placed. That direction is the whole design:
 *
 * - A cycle (`a` replies to `b` replies to `a`) is unreachable from the root,
 *   so it falls out as unplaced rather than needing a visited-guard.
 * - A relay matches `#e` against *any* `e` tag, so a subscription on this post
 *   also delivers replies belonging to other branches of the same thread —
 *   which is exactly the set that fails to connect to the root here.
 *
 * Replies are strangers' text, and the caller may be showing a stranger's
 * thread: nothing here trusts an event's own claim about where it belongs
 * beyond the tag it wrote.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { replyParentAddress, replyParentId } from './event-refs.ts';
import type { PostTargetMatch } from './post-target.ts';

/** Cap on replies held for one post, for the same reason `MAX_REACTIONS` has one. */
export const MAX_REPLIES = 500;

/** Backfill size for one level's REQ. */
export const DEFAULT_REPLIES_LIMIT = 100;

export const DEFAULT_REPLY_DEPTH = 3;

/**
 * Hard ceiling on {@link DEFAULT_REPLY_DEPTH}, because each level costs a live
 * subscription: the relay caps a client at 20, and the widget already spends
 * one on the post, four on profiles, two on quoted events and one on
 * reactions. Five leaves room to spare.
 */
export const MAX_REPLY_DEPTH = 5;

/** Nodes placed in one tree, whatever the depth. */
export const MAX_REPLY_NODES = 200;

export interface ReplyNode {
  event: NostrEvent;
  /** 1 for a direct reply to the post. */
  depth: number;
  /** Oldest first — a thread is a conversation and reads downwards. */
  children: ReplyNode[];
  /** Children left unplaced by the depth or node cap. */
  hiddenChildren: number;
}

export interface ReplyTree {
  roots: ReplyNode[];
  /** Nodes actually placed. */
  total: number;
  /** Replies the depth or node cap left out, at any level. */
  hidden: number;
  /**
   * Direct replies the node cap left out.
   *
   * Separate because there is no node to mark at the top level: without it,
   * reaching {@link MAX_REPLY_NODES} would drop replies with nothing on screen
   * to say it happened.
   */
  hiddenRoots: number;
  /**
   * Replies that never connected to the root.
   *
   * Reported rather than swallowed: it is also what a reply whose parent fell
   * off the {@link MAX_REPLIES} cap looks like, and silently dropping a
   * subtree would read as the thread simply not existing.
   */
  orphans: number;
}

export interface BuildReplyTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
  /**
   * The addressable post's own event id, when one has been fetched.
   *
   * A client replying to an article writes the coordinate *and*, usually, the
   * id of the version it was reading. Without this, that `e` tag names an event
   * the thread does not contain and the reply is read as an orphan.
   */
  rootId?: string;
}

/** Whether this is the *shape* of a reply — kind, and a parent tag to read. */
function isReplyEvent(event: NostrEvent, match: PostTargetMatch): boolean {
  if (event.kind !== 1 || event.id === match.id) {
    return false;
  }
  return replyParentId(event) !== undefined || replyParentAddress(event) !== undefined;
}

/**
 * Whether to keep an event a thread subscription delivered.
 *
 * The gate the controller applies **on delivery**, so a stranger cannot fill
 * {@link MAX_REPLIES} and push this post's real replies out of it: a relay
 * matches `#e` against any `e` tag, so anyone who writes
 * `["e", <this post>, "", "root"]` reaches this subscription no matter who they
 * were actually answering.
 *
 * Being strict here is safe because the levels re-ask. A grandchild usually
 * arrives on the *first* level — it names the thread root, and it is newer than
 * its parent, so it is delivered before it — and is dropped by this. Level two
 * then asks about the parent's id, which is the tag that grandchild really
 * carries, and it comes back. What this permanently drops is what no level
 * would have placed anyway.
 *
 * @param context `known` is the ids already held for this post; `rootId` the
 *   addressable post's own event id, as {@link BuildReplyTreeOptions.rootId}
 */
export function acceptsReply(
  event: NostrEvent,
  match: PostTargetMatch,
  context: { known?: { has(key: string): boolean }; rootId?: string } = {}
): boolean {
  if (!isReplyEvent(event, match)) {
    return false;
  }
  const known = context.known ?? { has: () => false };
  const key = parentKey(event, match, known, context.rootId);
  return key !== undefined && (key === (match.address ?? match.id) || known.has(key));
}

/** The id breaks a tie so the order never depends on arrival order. */
function olderFirst(a: NostrEvent, b: NostrEvent): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The key this event hangs under: another reply's id, or the coordinate of an
 * addressable post.
 *
 * A reply to an addressable event carries the coordinate *and* usually the id
 * of the version its author was reading; a reply to one of *its* replies
 * carries all three. So the `e` parent wins whenever it names a reply that is
 * actually here — which is why this needs the whole set before it can answer
 * for one event — and the coordinate is read only where that `e` parent is the
 * post itself or missing.
 *
 * The coordinate is deliberately not a fallback for an `e` parent that is
 * simply absent from the set: doing that promotes a grandchild whose own parent
 * never arrived into a direct reply, showing a reader an answer to something
 * else as an answer to the article.
 *
 * @param known Ids of the replies collected for this post
 * @param rootId The addressable post's own event id, if known
 */
function parentKey(
  event: NostrEvent,
  match: PostTargetMatch,
  known: { has(key: string): boolean },
  rootId?: string
): string | undefined {
  const parent = replyParentId(event);
  // An event naming itself is not a child of anything. Left unplaced rather
  // than handled downstream, where it would be a cycle of one.
  if (parent === event.id) {
    return undefined;
  }
  if (parent !== undefined && known.has(parent)) {
    return parent;
  }
  if (
    match.address !== undefined &&
    replyParentAddress(event) === match.address &&
    (parent === undefined || parent === rootId || parent === match.address)
  ) {
    return match.address;
  }
  // Whatever it named. Equal to the root key for a direct reply to a plain
  // post; anything else is for the caller to place or count as unconnected.
  return parent;
}

/**
 * @param match Which post the thread hangs under — the same value the
 *   subscription was built from, so a coordinate and an id cannot be confused
 * @returns Roots ordered oldest first, with the counts needed to say what was
 *   left out
 */
export function buildReplyTree(
  events: readonly NostrEvent[],
  match: PostTargetMatch,
  options: BuildReplyTreeOptions = {}
): ReplyTree {
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_REPLY_DEPTH);
  const maxNodes = Math.max(0, options.maxNodes ?? MAX_REPLY_NODES);

  const rootKey = match.address ?? match.id;
  if (rootKey === undefined) {
    return { roots: [], total: 0, hidden: 0, hiddenRoots: 0, orphans: 0 };
  }

  // Shape only. Whether an event *connects* is settled below, once every
  // candidate is in hand — `acceptsReply` cannot answer that for a set it is
  // still being used to build.
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    // First writer wins, matching `insertEvent`'s dedup: two copies of one id
    // are the same event as far as a reader is concerned.
    if (isReplyEvent(event, match) && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }

  const childrenOf = new Map<string, NostrEvent[]>();
  for (const event of byId.values()) {
    const key = parentKey(event, match, byId, options.rootId);
    if (key === undefined) {
      continue;
    }
    const siblings = childrenOf.get(key);
    if (siblings) {
      siblings.push(event);
    } else {
      childrenOf.set(key, [event]);
    }
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort(olderFirst);
  }

  const roots: ReplyNode[] = [];
  let total = 0;
  let hidden = 0;
  let hiddenRoots = 0;

  /** Where a level's children get attached, and what to charge if they cannot. */
  interface Slot {
    key: string;
    depth: number;
    into: ReplyNode[];
    /** Absent at the top level, where there is no node to mark. */
    owner?: ReplyNode;
  }

  /**
   * Everything below a key. Each event names exactly one parent, so what hangs
   * off a placed node is a forest and this cannot loop.
   */
  const descendants = (key: string): number => {
    let count = 0;
    const stack = [key];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const child of childrenOf.get(current) ?? []) {
        count += 1;
        stack.push(child.id);
      }
    }
    return count;
  };

  /**
   * `hiddenChildren` is the count a reader is shown under one reply, so it
   * stays the direct children. The top level has no node to mark, and something
   * has to say so or a cap reached there removes replies with no trace at all —
   * hence {@link ReplyTree.hiddenRoots}. The tree's own `hidden` is everything
   * left out, subtrees and all, so it reconciles against what arrived.
   */
  const skip = (slot: Slot, children: readonly NostrEvent[]): void => {
    if (slot.owner) {
      slot.owner.hiddenChildren += children.length;
    } else {
      hiddenRoots += children.length;
    }
    for (const child of children) {
      hidden += 1 + descendants(child.id);
    }
  };

  // Breadth-first, so the node cap spends itself on the shallow replies
  // everyone reads before a single deep sub-thread can take the budget.
  let frontier: Slot[] = [{ key: rootKey, depth: 1, into: roots }];
  while (frontier.length > 0) {
    const next: Slot[] = [];
    for (const slot of frontier) {
      const children = childrenOf.get(slot.key);
      if (children === undefined) {
        continue;
      }
      if (slot.depth > maxDepth) {
        skip(slot, children);
        continue;
      }
      for (let index = 0; index < children.length; index++) {
        if (total >= maxNodes) {
          skip(slot, children.slice(index));
          break;
        }
        const event = children[index];
        total += 1;
        const node: ReplyNode = { event, depth: slot.depth, children: [], hiddenChildren: 0 };
        slot.into.push(node);
        next.push({ key: event.id, depth: slot.depth + 1, into: node.children, owner: node });
      }
    }
    frontier = next;
  }

  return {
    roots,
    total,
    hidden,
    hiddenRoots,
    // What the caps left out is not an orphan — the tree marks that itself.
    // This is the set that never connected to the root at all.
    orphans: Math.max(0, byId.size - total - hidden),
  };
}
