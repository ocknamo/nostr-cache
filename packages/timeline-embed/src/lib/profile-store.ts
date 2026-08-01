/**
 * Keeps a kind 0 subscription in step with the authors currently on screen.
 *
 * The timeline learns about authors one event at a time, so asking for each
 * profile as it appears would mean a REQ per event. Instead this collects
 * pubkeys, waits out the burst, and re-opens a single
 * `{ kinds: [0], authors: [...] }` subscription covering everyone seen so far.
 *
 * Nothing here is Svelte-aware: it talks to a {@link ProfileSubscriber} (the
 * timeline's `RelayConnection`) and reports through `onChange`, so it can be
 * tested without a DOM. The relay handles the rest — kind 0 is replaceable, so
 * the local relay keeps only the newest version per author and read-through
 * fills IndexedDB, which is what makes avatars appear instantly on a reload.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { type Profile, parseProfileContent } from './profile.ts';

/** Batches the profile lookups triggered by a burst of incoming events. */
export const PROFILE_FETCH_DEBOUNCE_MS = 200;
/**
 * Cap on authors in one filter. A timeline is capped at a few hundred events,
 * but a relay that is fed junk should not make us send an unbounded REQ.
 */
export const MAX_PROFILE_AUTHORS = 200;

/** The slice of `RelayConnection` this store needs. */
export interface ProfileSubscriber {
  readonly isConnected: boolean;
  subscribe(
    subId: string,
    filters: Filter[],
    handlers: { onEvent: (event: NostrEvent) => void }
  ): void;
  unsubscribe(subId: string): void;
}

export interface ProfileStoreOptions {
  connection: ProfileSubscriber;
  /** Called with a fresh map whenever a profile is added or updated. */
  onChange: (profiles: Map<string, Profile>) => void;
  /**
   * Called for every kind 0 event delivered, before it is parsed.
   *
   * `TimelineController` uses this to run profile deliveries through
   * `CacheMetrics` too, so the cache/upstream counters cover the same
   * population of events the relay actually served.
   */
  onEvent?: (event: NostrEvent) => void;
  debounceMs?: number;
  maxAuthors?: number;
}

export class ProfileStore {
  private readonly options: ProfileStoreOptions;
  private readonly profiles = new Map<string, Profile>();
  /** created_at of the profile we kept, so an older replay cannot win. */
  private readonly seenAt = new Map<string, number>();
  /**
   * Authors still to look up, in the order first seen. An author leaves this
   * set as soon as a kind 0 arrives for them — see {@link answered}.
   */
  private readonly wanted = new Set<string>();
  /**
   * Authors a kind 0 has been delivered for, whether or not it parsed into
   * anything renderable.
   *
   * Tracked separately from `profiles` because a profile carrying only fields
   * the timeline does not render (`about`, `banner`, `lud16` …) parses to
   * undefined, and those are common. Keying "resolved" off `profiles` would
   * leave such authors in `wanted` forever, re-REQing them — and read-through
   * forwarding that REQ upstream — every time a new author appears.
   */
  private readonly answered = new Set<string>();
  private subId: string | null = null;
  private subSeq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private warnedAboutCap = false;
  /**
   * Set when a re-subscribe was wanted but the connection was down, so the next
   * {@link request} retries even if it names no author we have not seen.
   */
  private retryPending = false;

  constructor(options: ProfileStoreOptions) {
    this.options = options;
  }

  /** The profiles fetched so far, keyed by pubkey. */
  get current(): Map<string, Profile> {
    return new Map(this.profiles);
  }

  /**
   * Note that these authors need profiles.
   *
   * Cheap to call per event: pubkeys already covered are ignored, and a new one
   * only schedules the (debounced) re-subscribe.
   *
   * @param pubkeys Hex pubkeys of authors now on screen
   */
  request(pubkeys: string[]): void {
    if (this.closed) {
      return;
    }
    let added = false;
    for (const pubkey of pubkeys) {
      if (this.wanted.has(pubkey) || this.answered.has(pubkey)) {
        continue;
      }
      // The cap bounds the authors in one filter, and answered authors have
      // already left `wanted` — so this limits outstanding lookups, not how
      // many authors a long-running timeline may ever resolve.
      if (this.wanted.size >= (this.options.maxAuthors ?? MAX_PROFILE_AUTHORS)) {
        if (!this.warnedAboutCap) {
          this.warnedAboutCap = true;
          console.warn(
            `[nostr-timeline] Not looking up more than ${
              this.options.maxAuthors ?? MAX_PROFILE_AUTHORS
            } profiles at once; the remaining authors render with a shortened pubkey.`
          );
        }
        break;
      }
      this.wanted.add(pubkey);
      added = true;
    }
    if (added || this.retryPending) {
      this.schedule();
    }
  }

  /**
   * Close the subscription and stop fetching.
   *
   * Called on teardown and while the demo suspends the timeline for a cold
   * measurement — a live profile subscription would keep reading through to
   * upstream and refilling the cache being measured. Parsed profiles are kept
   * so a later {@link request} does not re-render as unknown authors.
   */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.subId) {
      this.options.connection.unsubscribe(this.subId);
      this.subId = null;
    }
  }

  /** Coalesce the lookups triggered by a burst of incoming events. */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.resubscribe();
    }, this.options.debounceMs ?? PROFILE_FETCH_DEBOUNCE_MS);
  }

  /**
   * Replace the subscription with one covering the authors still missing a
   * profile.
   *
   * Only the unresolved ones go in the filter. Asking for the whole set every
   * time would be quadratic on a live timeline — each new author would re-REQ
   * every profile already in hand, and read-through forwards that REQ upstream,
   * so the cost lands on someone else's relay rather than on our cache.
   *
   * The trade-off is that a profile is fetched once and then left alone: an
   * author who edits their kind 0 while the widget is open keeps their old name
   * until the page is reloaded. For an embedded read-only timeline that is a
   * better deal than re-asking upstream for hundreds of profiles per new author.
   */
  private resubscribe(): void {
    if (this.closed) {
      return;
    }
    if (!this.options.connection.isConnected) {
      // Remember that a lookup is owed. `request()` alone would not schedule
      // another pass once every on-screen author is already in `wanted`, so
      // without this the store would stay silent for the rest of its life.
      this.retryPending = true;
      return;
    }
    this.retryPending = false;
    const authors = [...this.wanted];
    if (this.subId) {
      this.options.connection.unsubscribe(this.subId);
      this.subId = null;
    }
    if (authors.length === 0) {
      return;
    }
    this.subSeq += 1;
    const subId = `profiles-${this.subSeq}`;
    this.subId = subId;
    this.options.connection.subscribe(subId, [{ kinds: [0], authors }], {
      onEvent: (event) => this.ingest(event),
    });
  }

  /**
   * Take one delivered kind 0 event.
   *
   * The author counts as answered as soon as anything arrives for them, even if
   * the content is unparseable or holds no field the timeline renders — the
   * relay has said all it has to say, and asking again would only repeat it.
   */
  private ingest(event: NostrEvent): void {
    if (this.closed || event.kind !== 0) {
      return;
    }
    this.options.onEvent?.(event);
    this.answered.add(event.pubkey);
    this.wanted.delete(event.pubkey);

    // Storage and upstream can both deliver a copy; keep the newer one.
    const seenAt = this.seenAt.get(event.pubkey);
    if (seenAt !== undefined && seenAt >= event.created_at) {
      return;
    }
    const profile = parseProfileContent(event.content);
    if (!profile) {
      return;
    }
    this.seenAt.set(event.pubkey, event.created_at);
    this.profiles.set(event.pubkey, profile);
    this.options.onChange(this.current);
  }
}
