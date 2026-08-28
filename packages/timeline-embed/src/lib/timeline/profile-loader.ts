/** Author profile (kind 0) lookups for the cards on screen. */

import type { NostrEvent } from '@nostr-cache/shared';
import { type Profile, parseProfileContent } from '../profile.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/** Well under the relay's per-client `maxSubscriptions` (20). */
const MAX_CONCURRENT_REQUESTS = 4;

/** Zero: the relay orders EOSE after the events it has accepted. */
const EOSE_GRACE_MS = 0;

/** Covers the relay's upstream EOSE timeout (3s) with room to spare. */
const REQUEST_TIMEOUT_MS = 5000;

interface ProfileSub {
  timer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
}

export interface ProfileLoaderOptions {
  ctx: LookupContext;
  /** Raise it for a relay that releases EOSE before the events it accepted. */
  eoseGraceMs?: number;
  onChange(profiles: Map<string, Profile>): void;
}

export class ProfileLoader {
  private readonly subs = new Map<string, ProfileSub>();
  /** created_at of the profile we kept, so an older copy cannot overwrite it. */
  private readonly seenAt = new Map<string, number>();
  private profiles = new Map<string, Profile>();
  private seq = 0;
  private readonly queue: RequestQueue<string>;

  constructor(private readonly options: ProfileLoaderOptions) {
    this.queue = new RequestQueue({
      key: (pubkey) => pubkey,
      // A REQ rx-nostr merely buffers still burns a slot and runs down its
      // watchdog, so a slow reconnect would time the whole budget out.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => this.subs.size < MAX_CONCURRENT_REQUESTS,
      start: (pubkey) => this.open(pubkey),
    });
  }

  /**
   * One author per REQ is what makes `upstreamFreshness` work per author:
   * coverage is judged per filter, so a filter naming many goes upstream in
   * full as soon as one is missing — and an author with no kind 0 always is.
   */
  request(pubkey: string): void {
    // The trigger lives in the DOM: a card scrolling into view during the
    // demo's cold benchmark would refill the cache being measured.
    if (!this.options.ctx.isActive()) {
      return;
    }
    this.queue.request(pubkey);
  }

  pump(): void {
    this.queue.pump();
  }

  /**
   * The authors asked for are kept, unlike the other three lookups: a resumed
   * widget renders the same cards. {@link reset} is what releases them.
   */
  close(): void {
    this.queue.clear();
    for (const [subId, sub] of [...this.subs]) {
      clearTimeout(sub.timer);
      clearTimeout(sub.watchdog);
      this.subs.delete(subId);
      this.options.ctx.connection.unsubscribe(subId);
    }
  }

  /** New filters bring their own authors. Parsed profiles stay, so no card flickers. */
  reset(): void {
    this.close();
    this.queue.reset();
  }

  /** kind 0 is replaceable, so EOSE frees the slot for the next author. */
  private open(pubkey: string): void {
    this.seq += 1;
    const subId = `profile-${this.seq}`;
    this.subs.set(subId, {
      // A refused REQ answers with neither EOSE nor CLOSED (just a NOTICE), so
      // nothing else would give the slot back.
      watchdog: setTimeout(() => this.finish(subId), REQUEST_TIMEOUT_MS),
    });
    this.options.ctx.connection.subscribe(subId, [{ kinds: [0], authors: [pubkey] }], {
      // Not closed on the first event: two relays can each answer with their
      // own copy, and the first to land is not the newest.
      onEvent: (event) => this.ingest(event),
      onEose: () => this.finishAfterEose(subId),
      onClosed: () => this.finish(subId),
    });
  }

  /** Deferred a task so a delivery already queued on the transport lands. */
  private finishAfterEose(subId: string): void {
    const sub = this.subs.get(subId);
    if (!sub || sub.timer) {
      return;
    }
    sub.timer = setTimeout(() => this.finish(subId), this.options.eoseGraceMs ?? EOSE_GRACE_MS);
  }

  private finish(subId: string): void {
    const sub = this.subs.get(subId);
    if (!sub) {
      return;
    }
    clearTimeout(sub.timer);
    clearTimeout(sub.watchdog);
    this.subs.delete(subId);
    this.options.ctx.connection.unsubscribe(subId);
    this.queue.pump();
  }

  private ingest(event: NostrEvent): void {
    if (event.kind !== 0) {
      return;
    }
    this.options.ctx.classifyDelivered(event.id);

    // The last copy to arrive is not necessarily the newest.
    const seenAt = this.seenAt.get(event.pubkey);
    if (seenAt !== undefined && seenAt >= event.created_at) {
      return;
    }
    const profile = parseProfileContent(event.content);
    if (!profile) {
      return;
    }
    this.seenAt.set(event.pubkey, event.created_at);
    // A new Map, so the view re-renders.
    this.profiles = new Map(this.profiles);
    this.profiles.set(event.pubkey, profile);
    this.options.onChange(this.profiles);
  }
}
