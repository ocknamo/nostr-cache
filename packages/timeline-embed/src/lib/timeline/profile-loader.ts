/**
 * Author profile (kind 0) lookups for the cards currently on screen.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { type Profile, parseProfileContent } from '../profile.ts';
import type { LookupContext } from './lookup-context.ts';
import { RequestQueue } from './request-queue.ts';

/**
 * Profile lookups allowed in flight at once.
 *
 * Well under the relay's `maxSubscriptions` (20), which it counts per client —
 * and the emulator gives every socket its own client id, so this budget is per
 * widget and the timeline's own subscription is the only thing sharing it.
 */
const MAX_CONCURRENT_REQUESTS = 4;

/**
 * How long a lookup stays open after EOSE.
 *
 * Zero: the relay orders EOSE after the events it has accepted
 * (`UpstreamCoordinator.flushEose` waits for its ingest chain), so there is
 * nothing left in flight to wait for.
 */
const EOSE_GRACE_MS = 0;

/**
 * Hard deadline on a single lookup.
 *
 * Covers the relay's upstream EOSE timeout (3s) plus the grace above, with
 * room to spare. Its real job is the case where no reply of any kind arrives —
 * see {@link ProfileLoader.open}.
 */
const REQUEST_TIMEOUT_MS = 5000;

interface ProfileSub {
  timer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
}

export interface ProfileLoaderOptions {
  ctx: LookupContext;
  /**
   * How long a lookup stays open after EOSE, in milliseconds.
   *
   * Zero by default — see {@link EOSE_GRACE_MS}. Raise it when talking
   * to a relay that releases EOSE before the events it has accepted; specs also
   * use it to give themselves a subscription they can observe.
   */
  eoseGraceMs?: number;
  onChange(profiles: Map<string, Profile>): void;
}

export class ProfileLoader {
  /** In-flight subscriptions, by subscription id. */
  private readonly subs = new Map<string, ProfileSub>();
  /** created_at of the profile we kept, so an older copy cannot overwrite it. */
  private readonly seenAt = new Map<string, number>();
  private profiles = new Map<string, Profile>();
  private seq = 0;
  private readonly queue: RequestQueue<string>;

  constructor(private readonly options: ProfileLoaderOptions) {
    this.queue = new RequestQueue({
      key: (pubkey) => pubkey,
      // Nothing is started while the socket is down. rx-nostr would happily
      // buffer the REQ and send it on reconnect, but a lookup that is merely
      // buffered still burns an in-flight slot and still runs down its watchdog
      // ({@link REQUEST_TIMEOUT_MS}), so a reconnect that takes a while would
      // time the whole budget out for nothing. Authors wait in the queue
      // instead, until the caller pumps again.
      canStart: () => this.options.ctx.isActive() && this.options.ctx.connection.isConnected,
      hasCapacity: () => this.subs.size < MAX_CONCURRENT_REQUESTS,
      start: (pubkey) => this.open(pubkey),
    });
  }

  /**
   * Fetch one author's profile. Called by the view when their card scrolls into
   * the viewport, so a timeline of 500 events only looks up the handful of
   * authors the reader can actually see.
   *
   * One author per REQ is what makes the relay's `upstreamFreshness` window
   * (see `relay-host.ts`) work per author: coverage is judged per filter, so a
   * filter naming many authors is forwarded upstream in full as soon as any one
   * of them is missing from the cache — and an author who has never published a
   * kind 0 is missing forever. Asking one at a time keeps each decision
   * independent, and keeps the filter a fixed size no matter what pubkeys the
   * upstream relay hands us.
   */
  request(pubkey: string): void {
    // `isActive` matters because the trigger lives in the DOM now: the cards
    // stay on screen while the demo benchmarks a cold cache, and one scrolling
    // into view would read through to upstream and refill the very cache being
    // measured.
    if (!this.options.ctx.isActive()) {
      return;
    }
    this.queue.request(pubkey);
  }

  /** Start whatever the budget now allows; call after a reconnect. */
  pump(): void {
    this.queue.pump();
  }

  /**
   * Close every in-flight lookup and drop the queue.
   *
   * Called from every path that stops the timeline. It matters most for
   * suspending: a live profile subscription keeps reading through to upstream
   * and refilling the very cache the caller is about to measure cold.
   *
   * The authors already asked for are kept, unlike every other lookup here: a
   * resumed widget renders the same cards, and asking again would re-fetch a
   * kind 0 that nothing has invalidated. {@link reset} is what releases them.
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

  /**
   * Close, and let every author be asked for again — as a new set of filters
   * brings its own authors, whose cards are about to be re-rendered.
   *
   * Profiles already parsed stay, so nobody flickers back to a pubkey while the
   * lookups re-run.
   */
  reset(): void {
    this.close();
    this.queue.reset();
  }

  /**
   * Open a one-shot subscription for a single author's profile.
   *
   * kind 0 is replaceable, so there is exactly one event to wait for: the
   * subscription is closed as soon as EOSE says the relay has nothing more,
   * which is what frees the slot for the next queued author.
   */
  private open(pubkey: string): void {
    this.seq += 1;
    const subId = `profile-${this.seq}`;
    this.subs.set(subId, {
      // A REQ the relay refuses answers with neither EOSE nor CLOSED — it logs
      // a NOTICE and returns (subscription limit, storage read failure). This
      // deadline is the only thing that gives such a slot back; without it the
      // budget drains one refusal at a time until the queue stops forever and
      // every later author is stuck on a shortened pubkey.
      watchdog: setTimeout(() => this.finish(subId), REQUEST_TIMEOUT_MS),
    });
    this.options.ctx.connection.subscribe(subId, [{ kinds: [0], authors: [pubkey] }], {
      // Deliberately not closed on the first event that arrives: two upstream
      // relays can each answer with their own copy, and the first to land is
      // not necessarily the newest. Waiting for EOSE lets `ingest` see them all
      // and keep the newest.
      onEvent: (event) => this.ingest(event),
      onEose: () => this.finishAfterEose(subId),
      onClosed: () => this.finish(subId),
    });
  }

  /**
   * Close the lookup once EOSE says there is nothing more.
   *
   * Deferred by a task rather than closed inline, so a delivery already queued
   * on the transport still lands. The 500ms this used to wait was covering a
   * relay that released EOSE before the events it had accepted
   * (`UpstreamCoordinator` ingests on a promise chain and drops deliveries once
   * the subscription is closed); `flushEose` now waits for that chain, so EOSE
   * genuinely means "delivered".
   */
  private finishAfterEose(subId: string): void {
    const sub = this.subs.get(subId);
    if (!sub || sub.timer) {
      return;
    }
    sub.timer = setTimeout(() => this.finish(subId), this.options.eoseGraceMs ?? EOSE_GRACE_MS);
  }

  /** Close a finished lookup and let the next queued one start. */
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

    // Storage holds only the newest copy, but two upstream relays can each
    // deliver theirs — so the last one to arrive is not necessarily the newest.
    const seenAt = this.seenAt.get(event.pubkey);
    if (seenAt !== undefined && seenAt >= event.created_at) {
      return;
    }
    const profile = parseProfileContent(event.content);
    if (!profile) {
      return;
    }
    this.seenAt.set(event.pubkey, event.created_at);
    // A fresh Map rather than a mutation, so the view re-renders.
    this.profiles = new Map(this.profiles);
    this.profiles.set(event.pubkey, profile);
    this.options.onChange(this.profiles);
  }
}
