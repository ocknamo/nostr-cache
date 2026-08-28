/**
 * Live subscription to one post's reactions (NIP-25 kind 7).
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { PostTarget } from '../post-target.ts';
import { MAX_REACTIONS, parseReaction } from '../reactions.ts';
import { insertEvent } from '../timeline-utils.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/** Backfill size for one REQ; the open subscription delivers past it. */
const DEFAULT_LIMIT = 200;

interface ReactionRequest {
  target: PostTarget;
  limit: number;
}

export interface ReactionWatcherOptions {
  ctx: LookupContext;
  onChange(reactions: Map<string, NostrEvent[]>): void;
}

export class ReactionWatcher {
  /**
   * Keyed by {@link PostTarget.key}, newest first. Raw events rather than a
   * summary, so a view re-deriving through `reactions.ts` stays correct.
   */
  private reactions = new Map<string, NostrEvent[]>();
  /** Open subscriptions, by {@link PostTarget.key}: one REQ per post. */
  private readonly subs = new Map<string, string>();
  private seq = 0;
  private readonly queue: RequestQueue<ReactionRequest>;

  constructor(private readonly options: ReactionWatcherOptions) {
    this.queue = new RequestQueue({
      key: (request) => request.target.key,
      // rx-nostr would buffer a REQ issued while the socket is down, but going
      // through the queue keeps one rule for every lookup the widget opens.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => true,
      start: (request) => this.open(request),
    });
  }

  reactionMap(): Map<string, NostrEvent[]> {
    return this.reactions;
  }

  /**
   * Watch one post's reactions. For `<nostr-post>`, never a timeline — that
   * would be one REQ per card. The subscription stays open, so a reaction that
   * lands while the reader is on the page needs no reload.
   *
   * @param limit How many to backfill; more may arrive live.
   */
  request(target: PostTarget, limit: number = DEFAULT_LIMIT): void {
    if (!this.options.ctx.isActive()) {
      return;
    }
    this.queue.request({ target, limit });
  }

  pump(): void {
    this.queue.pump();
  }

  /**
   * Keys are released so the original caller can ask again; nothing here
   * re-issues. What arrived stays — blanking the chips would look like the
   * reactions went away.
   */
  close(): void {
    this.queue.reset();
    for (const [key, subId] of [...this.subs]) {
      this.subs.delete(key);
      this.options.ctx.connection.unsubscribe(subId);
    }
  }

  /**
   * For a widget pointed at a different post. Publishes nothing: the caller
   * patches {@link reactionMap} into the snapshot it is already building.
   */
  clearEvents(): void {
    this.reactions = new Map();
  }

  private open({ target, limit }: ReactionRequest): void {
    this.seq += 1;
    const subId = `reactions-${this.seq}`;
    this.subs.set(target.key, subId);

    // NIP-25 points at an addressable post with `a` and a plain one with `e`;
    // asking with the wrong tag matches nothing.
    const filter: Filter =
      target.match.address !== undefined
        ? { kinds: [7], '#a': [target.match.address], limit }
        : { kinds: [7], '#e': [target.match.id ?? target.key], limit };

    this.options.ctx.connection.subscribe(subId, [filter], {
      onEvent: (event) => this.ingest(target, event),
      onEose: () => {
        // The subscription stays open on purpose; handled so nobody goes
        // looking for the close that is not here.
      },
      onClosed: (reason) => {
        // Not the widget's `error`: a banner would say the post failed when
        // only its reaction count stopped updating.
        console.warn(`[nostr-post] reaction subscription closed${reason ? `: ${reason}` : ''}`);
        this.subs.delete(target.key);
        // Released so a caller can ask again, but not re-queued: a relay that
        // refused this REQ would refuse the replacement, and the queue pumps
        // synchronously, so that would spin.
        this.queue.release(target.key);
      },
    });
  }

  /**
   * Filtered here because the cap is here: a relay matches `#e` against any `e`
   * tag, so reactions to *replies* would fill {@link MAX_REACTIONS} and push
   * out this post's own.
   */
  private ingest(target: PostTarget, event: NostrEvent): void {
    if (!parseReaction(event, target.match)) {
      return;
    }
    this.options.ctx.classifyDelivered(event.id);
    const current = this.reactions.get(target.key) ?? [];
    const next = insertEvent(current, event, MAX_REACTIONS);
    if (next === current) {
      // A duplicate delivery; a new Map would re-render every chip for nothing.
      return;
    }
    this.reactions = new Map(this.reactions);
    this.reactions.set(target.key, next);
    this.options.onChange(this.reactions);
  }
}
