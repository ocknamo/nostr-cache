/**
 * Lookups for events quoted by a `nostr:` reference (NIP-27).
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { EmbedTarget, EmbeddedEvent } from '../note-embeds.ts';
import { fetchLatestReplaceable } from '../one-shot-request.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/**
 * Lookups allowed in flight at once.
 *
 * Shares the relay's per-client `maxSubscriptions` (20) with the timeline's own
 * REQ, the four profile lookups, and — on a post detail — one reaction
 * subscription plus one per thread level (`MAX_REPLY_DEPTH`), so the widget's
 * ceiling is thirteen. Headroom matters here because a nested card that fails
 * for want of a subscription slot is indistinguishable from one whose event
 * does not exist.
 */
const MAX_CONCURRENT_REQUESTS = 2;

export interface EmbedLoaderOptions {
  ctx: LookupContext;
  /** A resolved quote names an author, and is a card awaiting a verdict. */
  onResolved(event: NostrEvent): void;
  onChange(embeds: Map<string, EmbeddedEvent>): void;
}

export class EmbedLoader {
  private embeds = new Map<string, EmbeddedEvent>();
  private inFlight = 0;
  /**
   * Cancels the in-flight lookups.
   *
   * Torn down on a different schedule from the timeline's own subscription: a
   * suspend must end them, and a later re-subscribe must be able to start new
   * ones.
   */
  private abort = new AbortController();
  private readonly queue: RequestQueue<EmbedTarget>;

  constructor(private readonly options: EmbedLoaderOptions) {
    this.queue = new RequestQueue({
      key: (target) => target.key,
      // Nothing is started while the socket is down: `fetchOnce` runs its own
      // deadline, so a lookup issued into a dead socket would burn a slot and
      // then report the quoted event as missing — permanently, since the key is
      // already de-duplicated. They wait in the queue instead.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => this.inFlight < MAX_CONCURRENT_REQUESTS,
      start: (target) => void this.open(target),
    });
  }

  embedMap(): Map<string, EmbeddedEvent> {
    return this.embeds;
  }

  /**
   * Fetch an event quoted by a `nostr:` reference.
   *
   * Called by a card when it scrolls into view, for the same reason a profile
   * lookup is: a timeline of 500 events must only pay for the quotes a reader
   * can actually see. Nesting is bounded by the caller — see `note-embeds.ts`.
   */
  request(target: EmbedTarget): void {
    if (!this.options.ctx.isActive() || !this.queue.request(target)) {
      return;
    }
    // So the card has something to render while it waits in the queue.
    this.set(target.key, { status: 'loading' });
  }

  /** Start whatever the budget now allows; call after a reconnect. */
  pump(): void {
    this.queue.pump();
  }

  /**
   * Cancel the in-flight lookups and let every key be asked for again: the
   * cards that asked are being torn down, and a resumed widget must be able to
   * ask again. A profile lookup keeps its keys instead — the author of a card
   * outlives the body that quoted something.
   */
  close(): void {
    this.queue.reset();
    this.abort.abort();
  }

  /**
   * Close, then re-arm for a widget that is being pointed somewhere new.
   *
   * Nothing is published here: the caller patches {@link embedMap} into the
   * same snapshot it clears the timeline with.
   */
  reset(): void {
    this.close();
    this.abort = new AbortController();
    // Unlike profiles, quoted events are dropped rather than kept: they are
    // keyed off the bodies of the events being replaced.
    this.embeds = new Map();
  }

  /**
   * A one-shot REQ rather than a subscription: there is exactly one event to
   * wait for, and `fetchOnce` already completes on EOSE, carries its own
   * timeout and sends the CLOSE on every path — including when {@link abort}
   * fires, which is what stops a torn-down widget from refilling the cache.
   *
   * Nothing here is allowed to throw. `fetchOnce` resolves rather than rejects,
   * but `fetchLatestReplaceable` compares versions through `supersedes` — code
   * from another package — and a throw would both leave an unhandled rejection
   * on the page and stop the queue, since the pump below would never run.
   */
  private async open(target: EmbedTarget): Promise<void> {
    this.inFlight += 1;
    const { connection } = this.options.ctx;
    const { signal } = this.abort;
    let event: NostrEvent | undefined;
    try {
      event = target.replaceable
        ? await fetchLatestReplaceable(connection, target.filter, { signal })
        : (await connection.fetchOnce([target.filter], { signal }))[0];
    } catch (error) {
      console.error(`[nostr-timeline] embed lookup for ${target.key} failed`, error);
    } finally {
      this.inFlight -= 1;
    }
    if (signal.aborted || !this.options.ctx.isActive()) {
      return;
    }
    if (!event) {
      // Not published, not upstream, or the relay never answered — none of
      // which is distinguishable from here, and all of which come out as the
      // abbreviated chip the reference was before this feature existed.
      this.set(target.key, { status: 'missing' });
      this.queue.pump();
      return;
    }
    this.options.ctx.classifyDelivered(event.id);
    this.set(target.key, { status: 'ready', event });
    this.options.onResolved(event);
    this.queue.pump();
  }

  /** A fresh Map rather than a mutation, so the view re-renders. */
  private set(key: string, embed: EmbeddedEvent): void {
    this.embeds = new Map(this.embeds);
    this.embeds.set(key, embed);
    this.options.onChange(this.embeds);
  }
}
