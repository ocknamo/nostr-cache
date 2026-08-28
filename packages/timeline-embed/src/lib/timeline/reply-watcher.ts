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
 * Ids carried by one level's REQ; the relay matches `#e` against each of them.
 * The overflow is not retried — a level is asked once — so a very wide thread
 * is read narrower rather than slower.
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
   * Not `subs.length`: a relay closing a level would shrink that, letting the
   * depth test open the thread past `maxDepth`.
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
   * coordinate. Undefined until it has arrived.
   */
  rootId(): string | undefined;
  /** A reply is a card like any other, so it too waits on a verdict. */
  onIngested(): void;
  onChange(replies: Map<string, NostrEvent[]>): void;
}

export class ReplyWatcher {
  /**
   * Keyed by {@link PostTarget.key}, newest first. Raw events rather than a
   * tree, so a view re-deriving through `reply-tree.ts` stays correct.
   */
  private replies = new Map<string, NostrEvent[]>();
  private readonly watches = new Map<string, ReplyWatch>();
  private seq = 0;
  private readonly queue: RequestQueue<ReplyRequest>;

  constructor(private readonly options: ReplyWatcherOptions) {
    this.queue = new RequestQueue({
      key: (request) => request.target.key,
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => true,
      start: (request) => this.openWatch(request),
    });
  }

  replyMap(): Map<string, NostrEvent[]> {
    return this.replies;
  }

  /**
   * Watch the thread under one post. Levels open as the one above them reaches
   * EOSE, so a thread that is only one deep costs one REQ.
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

  pump(): void {
    this.queue.pump();
  }

  /**
   * What arrived stays, as with reactions — blanking the thread would look like
   * the replies had been deleted.
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
   * For a widget pointed at a different post. Publishes nothing: the caller
   * patches {@link replyMap} into the snapshot it is already building.
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
      // Deferred a turn: events and EOSE arrive down two different rx-nostr
      // observables, so a level's last deliveries can still be queued when its
      // EOSE lands, and the frontier read here would be short or empty.
      onEose: () => {
        clearTimeout(watch.advance);
        watch.advance = setTimeout(() => this.advance(watch), 0);
      },
      onClosed: (reason) => {
        // Not the widget's `error`, as for a closed reaction subscription.
        console.warn(`[nostr-post] reply subscription closed${reason ? `: ${reason}` : ''}`);
        watch.subs = watch.subs.filter((id) => id !== subId);
        // The key is deliberately kept, unlike the reaction path's: a thread
        // is several subscriptions, and re-requesting would re-open the levels
        // still alive. A closed level costs only its own live updates.
      },
    });
  }

  /**
   * Open the next level with what this one delivered. Driven by EOSE rather
   * than by each arrival, the alternative being a REQ per reply; correct only
   * because this relay orders EOSE after the events it has accepted.
   *
   * A reply arriving after its level's EOSE is kept and rendered but opens no
   * level, or a live thread would re-subscribe every time someone answered.
   */
  private advance(watch: ReplyWatch): void {
    watch.advance = undefined;
    // Cleared before the guards: past the last level `ingest` keeps adding to
    // it, and nothing else would drain it.
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
   * Filtered here because the cap is here. A relay matches `#e` against any `e`
   * tag, so anyone can write `["e", <this post>, "", "root"]` and reach this
   * subscription; ungated, {@link MAX_REPLIES} of those would push the real
   * replies out, `insertEvent` dropping the oldest — a stranger with fresh
   * timestamps would decide what survives.
   *
   * It lives here rather than in the pure module because `acceptsReply` can
   * only answer for the set already held.
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
