/**
 * Level-by-level subscription to the thread under one post (kind 1, NIP-10).
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { PostTarget } from '../post-target.ts';
import {
  DEFAULT_REPLIES_LIMIT,
  DEFAULT_REPLY_DEPTH,
  MAX_REPLIES,
  MAX_REPLY_DEPTH,
  acceptsReply,
} from '../reply-tree.ts';
import { insertEvent } from '../timeline-utils.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/**
 * Ids carried by one level's REQ.
 *
 * A wide thread would otherwise put every reply of the level above into a
 * single filter, and the relay matches `#e` against each of them. What does not
 * fit is not retried later — a level is asked once — so a very wide thread is
 * read narrower rather than slower.
 */
const MAX_IDS_PER_LEVEL = 100;

export interface ReplyRequestOptions {
  /** Backfill size for one level's REQ. */
  limit?: number;
  /** Levels of the thread to open, counting the direct replies as one. */
  maxDepth?: number;
}

interface ReplyRequest {
  target: PostTarget;
  limit: number;
  maxDepth: number;
}

interface ReplyWatch extends ReplyRequest {
  /** Subscription ids still open. A relay that closes one removes it. */
  subs: string[];
  /**
   * Levels opened, which only ever grows.
   *
   * Not `subs.length`: a relay closing a level would shrink that, and the depth
   * test reading it would then let the thread open past `maxDepth`.
   */
  opened: number;
  /** Ids already put on a level's filter, so none is asked about twice. */
  asked: Set<string>;
  /** Ids delivered since the last level opened — the next level's question. */
  frontier: string[];
  /** Pending {@link ReplyWatcher.advance}, if a level has ended. */
  advance?: ReturnType<typeof setTimeout>;
}

export interface ReplyWatcherOptions {
  ctx: LookupContext;
  /**
   * The addressable post itself, which its direct replies name alongside the
   * coordinate. Undefined until the post has arrived, which is also when the
   * thread subscription has nothing to be about yet.
   */
  rootId(): string | undefined;
  /**
   * A reply is a card like any other, and the relay verifies signatures in the
   * background; without this they would stay dimmed for good.
   */
  onIngested(): void;
  onChange(replies: Map<string, NostrEvent[]>): void;
}

export class ReplyWatcher {
  /**
   * Replies collected for a post, keyed by {@link PostTarget.key} and newest
   * first. Raw events rather than a tree, so a view re-deriving through
   * `reply-tree.ts` stays correct as more arrive.
   */
  private replies = new Map<string, NostrEvent[]>();
  private readonly watches = new Map<string, ReplyWatch>();
  private seq = 0;
  private readonly queue: RequestQueue<ReplyRequest>;

  constructor(private readonly options: ReplyWatcherOptions) {
    this.queue = new RequestQueue({
      key: (request) => request.target.key,
      /** Held until the socket is up, as every lookup the widget opens is. */
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => true,
      start: (request) => this.openWatch(request),
    });
  }

  replyMap(): Map<string, NostrEvent[]> {
    return this.replies;
  }

  /**
   * Watch the thread under one post.
   *
   * Like a reaction watch and unlike a profile lookup, this is not
   * viewport-triggered: the post it names is the whole reason the widget
   * exists. The levels open as the one above them reaches EOSE, so a thread
   * that is only one deep costs one REQ.
   */
  request(target: PostTarget, options: ReplyRequestOptions = {}): void {
    if (!this.options.ctx.isActive()) {
      return;
    }
    this.queue.request({
      target,
      limit: options.limit ?? DEFAULT_REPLIES_LIMIT,
      maxDepth: Math.min(Math.max(1, options.maxDepth ?? DEFAULT_REPLY_DEPTH), MAX_REPLY_DEPTH),
    });
  }

  /** Open whatever is queued; call after a reconnect. */
  pump(): void {
    this.queue.pump();
  }

  /**
   * The subscriptions go; what arrived stays, as with reactions — blanking the
   * thread would look like the replies had been deleted.
   */
  close(): void {
    this.queue.reset();
    for (const [key, watch] of [...this.watches]) {
      this.watches.delete(key);
      clearTimeout(watch.advance);
      for (const subId of watch.subs) {
        this.options.ctx.connection.unsubscribe(subId);
      }
    }
  }

  /**
   * Drop the collected replies, for a widget pointed at a different post.
   *
   * Nothing is published here: the caller patches {@link replyMap} into the
   * snapshot it is already building.
   */
  clearEvents(): void {
    this.replies = new Map();
  }

  private openWatch(request: ReplyRequest): void {
    const watch: ReplyWatch = { ...request, subs: [], opened: 0, asked: new Set(), frontier: [] };
    this.watches.set(request.target.key, watch);
    this.openLevel(watch);
  }

  /**
   * @param ids The events this level answers. Absent for the first level, which
   *   asks about the post itself — by `a` when it is addressable, because that
   *   is what a reply to an article names.
   */
  private openLevel(watch: ReplyWatch, ids?: string[]): void {
    const { target, limit } = watch;
    this.seq += 1;
    const subId = `replies-${this.seq}`;
    watch.subs.push(subId);
    watch.opened += 1;

    const filter: Filter =
      ids !== undefined
        ? { kinds: [1], '#e': ids, limit }
        : target.match.address !== undefined
          ? { kinds: [1], '#a': [target.match.address], limit }
          : { kinds: [1], '#e': [target.match.id ?? target.key], limit };

    this.options.ctx.connection.subscribe(subId, [filter], {
      onEvent: (event) => this.ingest(watch, event),
      // Deferred by a turn rather than run here: events and EOSE reach this
      // class down two different rx-nostr observables, so the last deliveries
      // of a level can still be queued when its EOSE lands. Reading the
      // frontier now would ask the next level about a short list — or, for a
      // level whose replies all arrived that way, about nothing at all. A
      // profile lookup defers its close for the same reason.
      onEose: () => {
        clearTimeout(watch.advance);
        watch.advance = setTimeout(() => this.advance(watch), 0);
      },
      onClosed: (reason) => {
        // Not the widget's `error`, for the reason a closed reaction
        // subscription is not: the post is still on screen and still correct.
        console.warn(`[nostr-post] reply subscription closed${reason ? `: ${reason}` : ''}`);
        watch.subs = watch.subs.filter((id) => id !== subId);
        // The de-duplication deliberately keeps its entry, unlike the reaction
        // path which releases so the caller can ask again: a thread is several
        // subscriptions, and re-requesting it would re-open the levels that are
        // still perfectly alive. What a closed level costs is that one level's
        // live updates.
      },
    });
  }

  /**
   * Open the next level with what this one delivered.
   *
   * Driven by EOSE rather than by each arrival, because the alternative is a
   * REQ per reply. It is only correct because this relay orders EOSE after the
   * events it has accepted — the same property a zero profile grace rests on.
   *
   * Replies that arrive *after* their level's EOSE are kept and rendered, but
   * do not open a level of their own: a live thread would otherwise re-open a
   * subscription every time someone answered.
   */
  private advance(watch: ReplyWatch): void {
    watch.advance = undefined;
    // Cleared before the guards: past the last level `ingest` goes on adding to
    // it, and nothing would ever drain it again.
    const arrived = watch.frontier.filter((id) => !watch.asked.has(id));
    watch.frontier = [];
    if (!this.options.ctx.isActive() || watch.opened >= watch.maxDepth) {
      return;
    }
    const ids = arrived.slice(0, MAX_IDS_PER_LEVEL);
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      watch.asked.add(id);
    }
    this.openLevel(watch, ids);
  }

  /**
   * Filtered here rather than in the view, as reactions are and for the same
   * reason — the cap is here. A relay matches `#e` against any `e` tag, so
   * anyone at all can write `["e", <this post>, "", "root"]` and reach this
   * subscription; without the gate, {@link MAX_REPLIES} of those would push the
   * post's real replies out of the store, and `insertEvent` drops the oldest,
   * so a stranger with fresh timestamps decides what survives.
   *
   * The gate needs what is already held, which is why it lives here rather than
   * in the pure module: `acceptsReply` can only answer for a set.
   */
  private ingest(watch: ReplyWatch, event: NostrEvent): void {
    const current = this.replies.get(watch.target.key) ?? [];
    const held = new Set(current.map((reply) => reply.id));
    const rootId = this.options.rootId();
    const accepted = acceptsReply(event, watch.target.match, {
      known: held,
      ...(rootId ? { rootId } : {}),
    });
    if (!accepted) {
      return;
    }
    this.options.ctx.classifyDelivered(event.id);
    const next = insertEvent(current, event, MAX_REPLIES);
    if (next === current) {
      return;
    }
    this.replies = new Map(this.replies);
    this.replies.set(watch.target.key, next);
    watch.frontier.push(event.id);
    this.options.onChange(this.replies);
    this.options.onIngested();
  }
}
