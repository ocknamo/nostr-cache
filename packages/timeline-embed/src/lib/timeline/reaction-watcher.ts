/**
 * Live subscription to one post's reactions (NIP-25 kind 7).
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { PostTarget } from '../post-target.ts';
import { MAX_REACTIONS, parseReaction } from '../reactions.ts';
import { insertEvent } from '../timeline-utils.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/**
 * Backfill size for one REQ. Well under {@link MAX_REACTIONS}, which is where
 * the ones already received stop accumulating; a live subscription goes on
 * delivering past it.
 */
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
   * Reactions collected so far, keyed by {@link PostTarget.key} and newest
   * first. Raw events rather than a summary, so a view re-deriving through
   * `reactions.ts` stays correct as more arrive.
   */
  private reactions = new Map<string, NostrEvent[]>();
  /**
   * Open subscriptions, by {@link PostTarget.key}. One REQ per post, which fits
   * the relay's per-client cap of 20 alongside the timeline REQ, four profile
   * lookups and two embed lookups.
   */
  private readonly subs = new Map<string, string>();
  private seq = 0;
  private readonly queue: RequestQueue<ReactionRequest>;

  constructor(private readonly options: ReactionWatcherOptions) {
    this.queue = new RequestQueue({
      key: (request) => request.target.key,
      // Nothing is opened while the socket is down. rx-nostr would buffer the
      // REQ, but going through the queue keeps one rule for every lookup the
      // widget opens itself.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => true,
      start: (request) => this.open(request),
    });
  }

  reactionMap(): Map<string, NostrEvent[]> {
    return this.reactions;
  }

  /**
   * Watch one post's reactions.
   *
   * For `<nostr-post>`, never a timeline — that would be one REQ per card. Not
   * viewport-triggered like a profile or embed lookup: the post it names is the
   * whole reason the widget exists.
   *
   * The subscription stays open, so a reaction that lands while the reader is
   * on the page appears without a reload.
   *
   * @param limit How many reactions to backfill; more may arrive live.
   */
  request(target: PostTarget, limit: number = DEFAULT_LIMIT): void {
    if (!this.options.ctx.isActive()) {
      return;
    }
    this.queue.request({ target, limit });
  }

  /** Open whatever is queued; call after a reconnect. */
  pump(): void {
    this.queue.pump();
  }

  /**
   * The subscriptions go and every key is released, so a resumed controller can
   * be asked again — by the original caller, since nothing here re-issues it.
   * What arrived stays: blanking the chips would look like the reactions went
   * away.
   */
  close(): void {
    this.queue.reset();
    for (const [key, subId] of [...this.subs]) {
      this.subs.delete(key);
      this.options.ctx.connection.unsubscribe(subId);
    }
  }

  /** Drop the collected reactions, for a widget pointed at a different post. */
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
        // Nothing to do — the subscription stays open on purpose. Handled
        // explicitly so nobody goes looking for the close that is not here.
      },
      onClosed: (reason) => {
        // Not the widget's `error`: the post is still on screen and still
        // correct, and a banner over it would say the post failed when only its
        // reaction count stopped updating.
        console.warn(`[nostr-post] reaction subscription closed${reason ? `: ${reason}` : ''}`);
        this.subs.delete(target.key);
        // Released so a caller can ask again; without this the de-duplication
        // would make the closure permanent. Not re-queued here — a relay that
        // refused this REQ would refuse the replacement, and the queue is
        // pumped synchronously, so that would spin.
        this.queue.release(target.key);
      },
    });
  }

  /**
   * Filtered here rather than in the view because the cap is here: a relay
   * matches `#e` against any `e` tag, so under a busy thread the reactions to
   * *replies* would fill {@link MAX_REACTIONS} and push out this post's own.
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
