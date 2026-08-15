/**
 * Arranges the kind 1 events collected for a post into the thread under it.
 *
 * Pure, like `reactions.ts`: every rule below is testable without booting a
 * relay, and the subscriptions that feed it live in `timeline-controller.ts`.
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
}

/**
 * Whether an event is a reply worth keeping for this post at all.
 *
 * The gate the controller applies on delivery, so a busy thread's other
 * branches cannot fill {@link MAX_REPLIES} — the same job `parseReaction` does
 * for kind 7. It cannot decide whether the event connects to the root: a reply
 * may arrive before the one it answers, and only {@link buildReplyTree} sees
 * the whole set.
 */
export function acceptsReply(event: NostrEvent, match: PostTargetMatch): boolean {
  if (event.kind !== 1 || event.id === match.id) {
    return false;
  }
  return replyParentId(event) !== undefined || replyParentAddress(event) !== undefined;
}

/** The id breaks a tie so the order never depends on arrival order. */
function olderFirst(a: NostrEvent, b: NostrEvent): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The key this event hangs under: another reply's id, or the coordinate of an
 * addressable post.
 *
 * A reply to an addressable event carries the coordinate *and* usually the
 * article's own id, and a reply to one of its replies carries all three. So the
 * `e` parent wins whenever it names a reply that is actually here, and the
 * coordinate is what is left for the direct replies — which is also why this
 * needs the whole set before it can answer for one event.
 *
 * @param known Ids of the replies collected for this post
 */
function parentKey(
  event: NostrEvent,
  match: PostTargetMatch,
  known: { has(key: string): boolean }
): string | undefined {
  const parent = replyParentId(event);
  if (parent !== undefined && parent !== event.id && known.has(parent)) {
    return parent;
  }
  if (match.address !== undefined && replyParentAddress(event) === match.address) {
    return match.address;
  }
  // An event naming itself is not a child of anything. Left unplaced rather
  // than handled downstream, where it would be a cycle of one.
  return parent === event.id ? undefined : parent;
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
    return { roots: [], total: 0, hidden: 0, orphans: 0 };
  }

  // First writer wins, matching `insertEvent`'s dedup: two copies of one id are
  // the same event as far as a reader is concerned.
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (acceptsReply(event, match) && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }

  const childrenOf = new Map<string, NostrEvent[]>();
  for (const event of byId.values()) {
    const key = parentKey(event, match, byId);
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
   * `hiddenChildren` is the count a reader is shown, so it stays the direct
   * children; the tree's own `hidden` is everything left out, subtrees and all,
   * so it can be reconciled against what arrived.
   */
  const skip = (slot: Slot, children: readonly NostrEvent[]): void => {
    if (slot.owner) {
      slot.owner.hiddenChildren += children.length;
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
    // What the caps left out is not an orphan — the tree marks that itself.
    // This is the set that never connected to the root at all.
    orphans: Math.max(0, byId.size - total - hidden),
  };
}
