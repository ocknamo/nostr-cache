/** Lookups for events quoted by a `nostr:` reference (NIP-27). */

import type { NostrEvent } from '@nostr-cache/shared';
import type { EmbedTarget, EmbeddedEvent } from '../note-embeds.ts';
import { fetchLatestReplaceable } from '../one-shot-request.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/**
 * Kept low: a nested card that failed for want of a slot looks exactly like one
 * whose event does not exist. The widget's ceiling is thirteen of the relay's
 * twenty, the timeline REQ and the other lookups included.
 */
const MAX_CONCURRENT_REQUESTS = 2;

export interface EmbedLoaderOptions {
  ctx: LookupContext;
  /** A resolved quote names an author and is a card awaiting a verdict. */
  onResolved(event: NostrEvent): void;
  onChange(embeds: Map<string, EmbeddedEvent>): void;
}

export class EmbedLoader {
  private embeds = new Map<string, EmbeddedEvent>();
  private inFlight = 0;
  /** Replaced rather than reused, so a resumed widget can start new lookups. */
  private abort = new AbortController();
  private readonly queue: RequestQueue<EmbedTarget>;

  constructor(private readonly options: EmbedLoaderOptions) {
    this.queue = new RequestQueue({
      key: (target) => target.key,
      // `fetchOnce` runs its own deadline, so one issued into a dead socket
      // reports the quote missing — permanently, the key being spent.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => this.inFlight < MAX_CONCURRENT_REQUESTS,
      start: (target) => void this.open(target),
    });
  }

  embedMap(): Map<string, EmbeddedEvent> {
    return this.embeds;
  }

  /** Nesting is bounded by the caller; see `note-embeds.ts`. */
  request(target: EmbedTarget): void {
    if (!this.options.ctx.isActive() || !this.queue.request(target)) {
      return;
    }
    // So the card has something to render while it waits in the queue.
    this.set(target.key, { status: 'loading' });
  }

  pump(): void {
    this.queue.pump();
  }

  /** Keys are released, unlike a profile lookup's: a quote outlives nothing. */
  close(): void {
    this.queue.reset();
    this.abort.abort();
  }

  /** Publishes nothing: the caller patches {@link embedMap} into its own snapshot. */
  reset(): void {
    this.close();
    this.abort = new AbortController();
    // Dropped rather than kept, being keyed off bodies that are going away.
    this.embeds = new Map();
  }

  /**
   * Nothing here may throw: `fetchLatestReplaceable` compares versions through
   * another package's `supersedes`, and a throw would strand the queue.
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
      // Not published, not upstream, or never answered — indistinguishable, and
      // all rendered as the abbreviated chip.
      this.set(target.key, { status: 'missing' });
      this.queue.pump();
      return;
    }
    this.options.ctx.classifyDelivered(event.id);
    this.set(target.key, { status: 'ready', event });
    this.options.onResolved(event);
    this.queue.pump();
  }

  /** A new Map, so the view re-renders. */
  private set(key: string, embed: EmbeddedEvent): void {
    this.embeds = new Map(this.embeds);
    this.embeds.set(key, embed);
    this.options.onChange(this.embeds);
  }
}
