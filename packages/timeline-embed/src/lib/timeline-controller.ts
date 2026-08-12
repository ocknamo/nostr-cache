/**
 * Framework-agnostic driver for a timeline: acquires the shared in-page relay,
 * speaks NIP-01 to it over an emulated WebSocket, and publishes a snapshot of
 * the resulting state to a listener.
 *
 * Keeping this out of the Svelte component is what lets the custom element, the
 * iframe page and the demo site all render the exact same behaviour, and lets
 * the interesting parts be tested without a DOM.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { CacheMetrics, EventOrigin } from './cache-metrics.ts';
import type { EmbedTarget, EmbeddedEvent } from './note-embeds.ts';
import { fetchLatestReplaceable } from './one-shot-request.ts';
import { type Profile, parseProfileContent } from './profile.ts';
import { type ConnectionStatus, RelayConnection } from './relay-connection.ts';
import { type RelayHost, type RelayHostConfig, acquireRelayHost } from './relay-host.ts';
import { type RequestDurations, RequestTimer } from './request-timer.ts';
import { insertEvent } from './timeline-utils.ts';
import { type ValidationStatus, fetchValidationStatuses, hasPending } from './validation-status.ts';

/** Batches the validation lookups triggered by a burst of incoming events. */
const VALIDATION_FETCH_DEBOUNCE_MS = 200;
/**
 * Profile lookups allowed in flight at once.
 *
 * Well under the relay's `maxSubscriptions` (20), which it counts per client —
 * and the emulator gives every socket its own client id, so this budget is per
 * widget and the timeline's own subscription is the only thing sharing it.
 */
const MAX_CONCURRENT_PROFILE_REQUESTS = 4;
/**
 * Lookups for quoted events allowed in flight at once.
 *
 * Shares the relay's per-client `maxSubscriptions` (20) with the timeline's own
 * REQ and the four profile lookups above, so the widget's ceiling is seven —
 * with plenty of headroom, because a nested card that fails for want of a
 * subscription slot is indistinguishable from one whose event does not exist.
 */
const MAX_CONCURRENT_EMBED_REQUESTS = 2;
/**
 * How long a profile lookup stays open after EOSE.
 *
 * Zero: the relay orders EOSE after the events it has accepted
 * (`UpstreamCoordinator.flushEose` waits for its ingest chain), so there is
 * nothing left in flight to wait for. This was 500ms while that was untrue, and
 * every visible author's card paid it on a cold cache.
 * See {@link TimelineController.finishAfterEose}.
 */
const PROFILE_EOSE_GRACE_MS = 0;
/**
 * Hard deadline on a single profile lookup.
 *
 * Covers the relay's upstream EOSE timeout (3s) plus the grace above, with
 * room to spare. Its real job is the case where no reply of any kind arrives —
 * see {@link TimelineController.openProfileRequest}.
 */
const PROFILE_REQUEST_TIMEOUT_MS = 5000;
/** Lazy validation runs in the background, so re-poll while anything is pending. */
const VALIDATION_POLL_INTERVAL_MS = 5000;

/**
 * How many polls a watch waits for the event to appear in storage before
 * concluding the cache does not hold it.
 *
 * Deliveries are stored before they reach the client, so the first look
 * normally finds the event already. The retries cover an ingest that is still
 * in flight — and, because the poll interval is 5s, they also give a storage
 * read error time to clear before it is read as an absence.
 */
const VALIDATION_WATCH_MAX_MISSES = 4;

/** Progress of the two-stage follow-list resolution; see {@link FilterSource}. */
export interface FollowsState {
  /**
   * `missing` means no subscription was opened at all; `dropped` means the
   * event the authors were built from is no longer in the cache.
   */
  status: 'resolving' | 'ready' | 'missing' | 'dropped';
  /** Authors on the timeline filter, including the subject when included. */
  count: number;
  /** Follow-list entries dropped by `max-follows`. */
  truncated: number;
}

/**
 * Everything a {@link FilterSource} is given to resolve its filters with.
 *
 * Deliberately narrow: the controller hands over a connection and a way to
 * report progress, and stays ignorant of what the source is fetching or how it
 * interprets it. Teaching the controller about NIP-02 instead would mean every
 * test of follow-list parsing had to boot a relay first.
 */
export interface FilterSourceContext {
  connection: RelayConnection;
  /** Aborts on `stop()` / `suspend()`; check it after every await. */
  signal: AbortSignal;
  setFollows: (follows: FollowsState) => void;
  /**
   * Watch an event the timeline's whole author set rests on, and call back if
   * the cache stops holding it. See {@link TimelineController.watchValidation}
   * for what that does and does not prove.
   */
  watchValidation: (eventId: string, onDropped: () => void) => void;
}

/**
 * Filters resolved at runtime, from data only a relay can supply.
 *
 * Sits between connect and subscribe, which is the only point where a REQ can
 * be issued to work out what the real REQ should be. Returning an empty array
 * means "do not subscribe at all" — the caller has decided there is nothing
 * safe to ask for, and the controller must not invent a fallback filter.
 */
export type FilterSource = (context: FilterSourceContext) => Promise<Filter[]>;

export interface TimelineState {
  status: ConnectionStatus;
  events: NostrEvent[];
  origins: Map<string, EventOrigin>;
  validationStatuses: Map<string, ValidationStatus>;
  /** Author profiles (kind 0) fetched so far, keyed by pubkey. */
  profiles: Map<string, Profile>;
  /**
   * Events quoted by a `nostr:` reference in some body, keyed by the referring
   * entity's `embedKey`. Every card the reader can see has an entry, whether it
   * is still loading, has arrived, or could not be found.
   */
  embeds: Map<string, EmbeddedEvent>;
  eose: boolean;
  error?: string;
  /** Set only by a {@link FilterSource} that reports one; see {@link FollowsState}. */
  follows?: FollowsState;
}

export interface TimelineControllerOptions {
  /** Relay settings. The first widget on a page wins — see `relay-host.ts`. */
  host?: RelayHostConfig;
  /** Cap on events held in the timeline. */
  maxEvents?: number;
  /**
   * How long a profile lookup stays open after EOSE, in milliseconds.
   *
   * Zero by default — see {@link PROFILE_EOSE_GRACE_MS}. Raise it when talking
   * to a relay that releases EOSE before the events it has accepted; specs also
   * use it to give themselves a subscription they can observe.
   */
  profileEoseGraceMs?: number;
  /**
   * Seconds between validation re-checks, as milliseconds.
   *
   * Paired with the relay's own `lazyValidateInterval`: a caller that speeds
   * verification up wants the widget to notice at the same rate. Specs use it to
   * avoid spending {@link VALIDATION_WATCH_MAX_MISSES} real poll intervals.
   */
  validationPollIntervalMs?: number;
  /** Called with a fresh snapshot whenever anything changes. */
  onChange: (state: TimelineState) => void;
}

export class TimelineController {
  private connection: RelayConnection;
  private relayHost?: RelayHost;
  /** Authors a lookup has been started for, so a repeat costs nothing. */
  private requestedProfiles = new Set<string>();
  /** Authors waiting for an in-flight slot. */
  private pendingProfiles: string[] = [];
  /** In-flight profile subscriptions, by subscription id. */
  private readonly profileSubs = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; watchdog?: ReturnType<typeof setTimeout> }
  >();
  /** created_at of the profile we kept, so an older copy cannot overwrite it. */
  private readonly profileSeenAt = new Map<string, number>();
  private profileSeq = 0;
  /** Embed keys a lookup has been started for, so a repeat costs nothing. */
  private requestedEmbeds = new Set<string>();
  /** Lookups waiting for an in-flight slot. */
  private pendingEmbeds: EmbedTarget[] = [];
  /** Lookups currently in flight. */
  private embedsInFlight = 0;
  /**
   * Cancels the in-flight embed lookups.
   *
   * Separate from {@link filterSourceAbort} because these outlive a filter
   * source and are torn down on a different schedule — a `suspend()` must end
   * them, and a later `applyFilter()` must be able to start new ones.
   */
  private embedAbort = new AbortController();
  private readonly timer = new RequestTimer();
  private readonly options: TimelineControllerOptions;
  private state: TimelineState = {
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    embeds: new Map(),
    eose: false,
  };
  private currentSubId: string | null = null;
  private subSeq = 0;
  private validationFetchTimer?: ReturnType<typeof setTimeout>;
  private validationPollTimer?: ReturnType<typeof setTimeout>;
  /**
   * Kept apart from the two timers above because it is not tied to the current
   * subscription: the event it watches was fetched before that subscription
   * existed, so {@link subscribe} clearing it would end the watch early. It is
   * bounded by {@link filterSourceAbort} instead.
   */
  private validationWatchTimer?: ReturnType<typeof setTimeout>;
  /**
   * Cancels an in-flight {@link FilterSource}.
   *
   * A source blocks for up to its own watchdog (5s) and `stop()` can land at
   * any point in there. The subscriptions a source opens are its own, outside
   * this class's profile bookkeeping, so nothing else would close them.
   *
   * Replaced rather than reused after a `suspend()`, so a controller that is
   * resumed with {@link applyFilter} is not left permanently aborted.
   */
  private filterSourceAbort = new AbortController();
  private stopped = false;
  /** Whether the connection ever came up, so a later error means it was lost. */
  private connectedOnce = false;
  /** Set by suspend(), cleared by the next subscribe(). */
  private suspended = false;
  /** Settles on stop(), so a pending connect() cannot leave start() hanging. */
  private readonly stopSignal: Promise<void>;
  private signalStopped!: () => void;

  constructor(options: TimelineControllerOptions) {
    this.options = options;
    this.stopSignal = new Promise((resolve) => {
      this.signalStopped = resolve;
    });
    this.connection = new RelayConnection({
      onStatusChange: (status) => {
        this.patch({ status });
        if (status === 'connected') {
          // A reconnect gives the queue somewhere to drain to again. The
          // timeline REQ needs no help — rx-nostr re-sends the subscriptions it
          // was holding — but profile lookups are opened one at a time by this
          // class, so the ones parked while the socket was down have to be
          // started from here.
          this.patch({ error: undefined });
          this.pumpProfileQueue();
          this.pumpEmbedQueue();
        } else if (status === 'error' && this.connectedOnce) {
          // Reconnection gave up. Say so, or the widget goes on showing a
          // timeline that stopped updating some minutes ago with nothing to
          // suggest anything is wrong. A failed *first* connection is not this
          // case: start() reports that one with the reason it failed for.
          this.patch({
            error: 'リレーとの接続が切れました。ページを再読み込みしてください',
          });
        }
        this.connectedOnce ||= status === 'connected';
      },
    });
  }

  /** The shared relay, once {@link start} has resolved. */
  get host(): RelayHost | undefined {
    return this.relayHost;
  }

  /** Cache-origin counters for this page's relay. */
  get metrics(): CacheMetrics | undefined {
    return this.relayHost?.metrics;
  }

  /** Elapsed times for the current subscription. */
  durations(): RequestDurations | undefined {
    return this.currentSubId ? this.timer.durations(this.currentSubId) : undefined;
  }

  /**
   * Boot the relay (if this is the first widget) and open the first
   * subscription.
   *
   * @param source NIP-01 filters for the timeline — they travel as one REQ, so
   *   an event matching any of them lands in the same timeline — or a
   *   {@link FilterSource} that works them out from the relay once it is
   *   connected. A source that resolves to no filters opens no subscription.
   */
  async start(source: Filter[] | FilterSource): Promise<void> {
    try {
      this.relayHost = await acquireRelayHost(this.options.host);
    } catch (error) {
      this.patch({ status: 'error', error: `リレーの起動に失敗しました: ${message(error)}` });
      return;
    }
    // stop() may have been called while the relay was booting.
    if (this.stopped) {
      await this.relayHost.release();
      this.relayHost = undefined;
      return;
    }
    try {
      // stop() detaches the socket's handlers, so a connect() in flight would
      // otherwise never settle and this method would hang forever.
      await Promise.race([this.connection.connect(this.relayHost.interceptUrl), this.stopSignal]);
    } catch (error) {
      this.patch({ status: 'error', error: `接続に失敗しました: ${message(error)}` });
      return;
    }
    if (this.stopped) {
      return;
    }

    if (typeof source !== 'function') {
      this.subscribe(source);
      return;
    }

    let filters: Filter[];
    try {
      filters = await source({
        connection: this.connection,
        signal: this.filterSourceAbort.signal,
        setFollows: (follows) => this.applyFollows(follows),
        watchValidation: (eventId, onInvalid) => this.watchValidation(eventId, onInvalid),
      });
    } catch (error) {
      // `follows` goes with it: a source that threw is not going to report
      // again, so leaving it on `resolving` would stack "取得しています…" and
      // "読み込み中…" underneath an error banner that has already said it failed.
      this.patch({
        error: `購読フィルタの解決に失敗しました: ${message(error)}`,
        follows: this.state.follows && { status: 'missing', count: 0, truncated: 0 },
      });
      return;
    }
    if (this.stopped) {
      return;
    }
    // The source found nothing safe to ask for, and has already said why
    // through `setFollows`. Substituting a widened fallback here is the one
    // thing this must never do — see `follow-list.ts`.
    if (filters.length === 0) {
      return;
    }
    this.subscribe(filters);
  }

  /** Replace the subscription, clearing the timeline and restarting timing. */
  applyFilter(filters: Filter[]): void {
    this.subscribe(filters);
  }

  /**
   * Close the current subscription while keeping the relay and connection.
   *
   * Used while benchmarking: a live subscription keeps reading through to the
   * upstream and refilling the cache, which would contaminate a cold pass.
   * Call {@link applyFilter} to start again.
   */
  suspend(): void {
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.suspended = true;
    // A filter source that is still resolving holds a subscription of its own,
    // which would go on reading through to upstream and refilling the cache the
    // caller is about to measure cold. Aborting also ends its validation watch,
    // and drops the resolution state with it — leaving `resolving` on screen
    // would strand the widget on "フォローリストを取得しています…" for good,
    // because the source it was waiting for is never going to report again.
    this.filterSourceAbort.abort();
    this.patch({ follows: undefined });
    this.closeProfiles();
    this.closeEmbeds();
    this.clearTimers();
  }

  /**
   * Close the subscription and release this widget's claim on the relay. Safe
   * to call more than once, and safe to call while {@link start} is in flight.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStopped();
    this.filterSourceAbort.abort();
    this.clearTimers();
    this.closeProfiles();
    this.closeEmbeds();
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.connection.disconnect();
    const host = this.relayHost;
    this.relayHost = undefined;
    await host?.release();
  }

  private subscribe(filters: Filter[]): void {
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.clearTimers();
    // The new filters bring their own authors, and the cards that will ask for
    // them are about to be re-rendered. Profiles already parsed stay in state,
    // so nobody flickers back to a pubkey while the lookups re-run.
    this.suspended = false;
    if (this.filterSourceAbort.signal.aborted && !this.stopped) {
      // Re-arm after a suspend, so a resumed controller can run a filter source
      // (and the validation watch that comes with it) again.
      this.filterSourceAbort = new AbortController();
    }
    this.closeProfiles();
    this.requestedProfiles = new Set();
    // Unlike profiles, quoted events are dropped rather than kept: they are
    // keyed off the bodies of the events being replaced, and the cards that
    // asked for them are about to go away.
    this.closeEmbeds();
    this.embedAbort = new AbortController();
    // Timings are per subscription id and never revisited once replaced.
    this.timer.clear();
    this.patch({
      events: [],
      origins: new Map(),
      validationStatuses: new Map(),
      embeds: new Map(),
      eose: false,
      error: undefined,
    });

    if (!this.connection.isConnected && !this.isRecovering()) {
      // Say so rather than leaving the UI on "読み込み中…" forever.
      this.patch({ error: 'リレーに接続していないため購読できません' });
      return;
    }

    this.subSeq += 1;
    const subId = `timeline-${this.subSeq}`;
    this.currentSubId = subId;
    this.timer.start(subId);

    this.connection.subscribe(subId, filters, {
      onEvent: (event) => {
        this.timer.markEvent(subId);
        // Without a host there is nothing that can tell cache from upstream;
        // leave the origin unset so no badge is rendered rather than guessing.
        const origin = this.relayHost?.metrics.classifyDelivered(event.id);
        const origins = new Map(this.state.origins);
        if (origin) {
          origins.set(event.id, origin);
        }
        this.patch({
          events: insertEvent(this.state.events, event, this.options.maxEvents),
          origins,
        });
        this.scheduleValidationRefresh();
      },
      onEose: () => {
        this.timer.markEose(subId);
        this.patch({ eose: true });
        this.scheduleValidationRefresh();
      },
      onClosed: (reason) => {
        this.patch({ error: `購読が閉じられました${reason ? `: ${reason}` : ''}` });
      },
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
   *
   * Repeat calls for the same author are ignored: that is request de-duplication
   * (the same card can scroll in and out), not a second cache in front of the
   * relay's — whether a cached copy is still fresh remains the relay's call.
   */
  requestProfile(pubkey: string): void {
    // `suspended` matters because the trigger lives in the DOM now: the cards
    // stay on screen while the demo benchmarks a cold cache, and one scrolling
    // into view would read through to upstream and refill the very cache being
    // measured. Nothing else stops it — unlike the old design, where lookups
    // could only be triggered by timeline events that suspend() had cut off.
    if (this.stopped || this.suspended) {
      return;
    }
    if (this.requestedProfiles.has(pubkey)) {
      return;
    }
    this.requestedProfiles.add(pubkey);
    this.pendingProfiles.push(pubkey);
    this.pumpProfileQueue();
  }

  /**
   * Start as many queued lookups as the in-flight budget allows.
   *
   * The relay caps each *client* at `maxSubscriptions` (20, set in
   * `relay-host.ts`; the emulator gives every socket its own client id, so a
   * second widget on the page has its own budget). Every visible card can ask
   * at once — an iframe embed sized to its content has *every* card in the
   * viewport — so without a budget a first paint would run past that cap.
   *
   * Nothing is started while the socket is down. rx-nostr would happily buffer
   * the REQ and send it on reconnect, but a lookup that is merely buffered
   * still burns an in-flight slot and still runs down its watchdog
   * ({@link PROFILE_REQUEST_TIMEOUT_MS}), so a reconnect that takes a while
   * would time the whole budget out for nothing. Authors wait in the queue
   * instead, and the `connected` status handler pumps it again.
   */
  private pumpProfileQueue(): void {
    if (this.stopped || this.suspended || !this.connection.isConnected) {
      return;
    }
    while (
      this.pendingProfiles.length > 0 &&
      this.profileSubs.size < MAX_CONCURRENT_PROFILE_REQUESTS
    ) {
      const pubkey = this.pendingProfiles.shift();
      if (pubkey !== undefined) {
        this.openProfileRequest(pubkey);
      }
    }
  }

  /**
   * Open a one-shot subscription for a single author's profile.
   *
   * kind 0 is replaceable, so there is exactly one event to wait for: the
   * subscription is closed as soon as EOSE says the relay has nothing more,
   * which is what frees the slot for the next queued author.
   */
  private openProfileRequest(pubkey: string): void {
    this.profileSeq += 1;
    const subId = `profile-${this.profileSeq}`;
    this.profileSubs.set(subId, {
      // A REQ the relay refuses answers with neither EOSE nor CLOSED — it logs
      // a NOTICE and returns (subscription limit, storage read failure). This
      // deadline is the only thing that gives such a slot back; without it the
      // budget drains one refusal at a time until the queue stops forever and
      // every later author is stuck on a shortened pubkey.
      watchdog: setTimeout(() => this.finishProfileRequest(subId), PROFILE_REQUEST_TIMEOUT_MS),
    });
    this.connection.subscribe(subId, [{ kinds: [0], authors: [pubkey] }], {
      // Deliberately not closed on the first event that arrives: two upstream
      // relays can each answer with their own copy, and the first to land is
      // not necessarily the newest. Waiting for EOSE lets `ingestProfile` see
      // them all and keep the newest.
      onEvent: (event) => this.ingestProfile(event),
      onEose: () => this.finishAfterEose(subId),
      onClosed: () => this.finishProfileRequest(subId),
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
    const entry = this.profileSubs.get(subId);
    if (!entry || entry.timer) {
      return;
    }
    entry.timer = setTimeout(
      () => this.finishProfileRequest(subId),
      this.options.profileEoseGraceMs ?? PROFILE_EOSE_GRACE_MS
    );
  }

  /** Close a finished lookup and let the next queued one start. */
  private finishProfileRequest(subId: string): void {
    const entry = this.profileSubs.get(subId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    clearTimeout(entry.watchdog);
    this.profileSubs.delete(subId);
    this.connection.unsubscribe(subId);
    this.pumpProfileQueue();
  }

  /**
   * Take one delivered kind 0 event into the rendered profile map.
   *
   * Profile deliveries are classified through `CacheMetrics` too, so the
   * cache/upstream counters describe the same population of events: the
   * instrumented upstream pool already counts kind 0 arrivals as upstream
   * events, and leaving them unclassified would make the delivered/cache-hit
   * numbers cover a smaller set than the upstream one.
   */
  private ingestProfile(event: NostrEvent): void {
    if (event.kind !== 0) {
      return;
    }
    this.relayHost?.metrics.classifyDelivered(event.id);

    // Storage holds only the newest copy, but two upstream relays can each
    // deliver theirs — so the last one to arrive is not necessarily the newest.
    const seenAt = this.profileSeenAt.get(event.pubkey);
    if (seenAt !== undefined && seenAt >= event.created_at) {
      return;
    }
    const profile = parseProfileContent(event.content);
    if (!profile) {
      return;
    }
    this.profileSeenAt.set(event.pubkey, event.created_at);
    const profiles = new Map(this.state.profiles);
    profiles.set(event.pubkey, profile);
    this.patch({ profiles });
  }

  /**
   * Close every in-flight lookup and drop the queue.
   *
   * Called from every path that stops the timeline. It matters most for
   * `suspend()`: a live profile subscription keeps reading through to upstream
   * and refilling the very cache the caller is about to measure cold.
   */
  private closeProfiles(): void {
    this.pendingProfiles = [];
    for (const [subId, entry] of [...this.profileSubs]) {
      clearTimeout(entry.timer);
      clearTimeout(entry.watchdog);
      this.profileSubs.delete(subId);
      this.connection.unsubscribe(subId);
    }
  }

  /**
   * Fetch an event quoted by a `nostr:` reference, so the card that carries the
   * reference can render it nested inside itself (NIP-27).
   *
   * Called by a card when it scrolls into view, for the same reason
   * {@link requestProfile} is: a timeline of 500 events must only pay for the
   * quotes a reader can actually see. Nesting is bounded by the caller — see
   * `note-embeds.ts` — so a chain of quotes costs at most five lookups deep.
   *
   * Repeat calls for the same target are ignored, which is request
   * de-duplication and not a cache in front of the relay's: the same reference
   * appears on every card that quotes it, and both those cards scroll in and
   * out.
   */
  requestEmbed(target: EmbedTarget): void {
    if (this.stopped || this.suspended) {
      return;
    }
    if (this.requestedEmbeds.has(target.key)) {
      return;
    }
    this.requestedEmbeds.add(target.key);
    // Recorded before the lookup starts so the card has something to render
    // while it is in flight — including while it waits in the queue below.
    this.setEmbed(target.key, { status: 'loading' });
    this.pendingEmbeds.push(target);
    this.pumpEmbedQueue();
  }

  /**
   * Start as many queued lookups as the in-flight budget allows.
   *
   * Nothing is started while the socket is down: `fetchOnce` runs its own
   * deadline, so a lookup issued into a dead socket would burn a slot and then
   * report the quoted event as missing — permanently, since the key is already
   * in `requestedEmbeds`. They wait in the queue instead, and the `connected`
   * status handler pumps it again.
   */
  private pumpEmbedQueue(): void {
    if (this.stopped || this.suspended || !this.connection.isConnected) {
      return;
    }
    while (this.pendingEmbeds.length > 0 && this.embedsInFlight < MAX_CONCURRENT_EMBED_REQUESTS) {
      const target = this.pendingEmbeds.shift();
      if (target !== undefined) {
        void this.openEmbedRequest(target);
      }
    }
  }

  /**
   * Run one lookup to completion.
   *
   * A one-shot REQ rather than a subscription: there is exactly one event to
   * wait for, and `fetchOnce` already completes on EOSE, carries its own
   * timeout and sends the CLOSE on every path — including when `embedAbort`
   * fires, which is what stops a torn-down widget from refilling the cache.
   *
   * Nothing here is allowed to throw. `fetchOnce` resolves rather than rejects,
   * but `fetchLatestReplaceable` compares versions through `supersedes` — code
   * from another package — and a throw would both leave an unhandled rejection
   * on the page and stop the queue, since the pump below would never run.
   */
  private async openEmbedRequest(target: EmbedTarget): Promise<void> {
    this.embedsInFlight += 1;
    const { signal } = this.embedAbort;
    let event: NostrEvent | undefined;
    try {
      event = target.replaceable
        ? await fetchLatestReplaceable(this.connection, target.filter, { signal })
        : (await this.connection.fetchOnce([target.filter], { signal }))[0];
    } catch (error) {
      console.error(`[nostr-timeline] embed lookup for ${target.key} failed`, error);
    } finally {
      this.embedsInFlight -= 1;
    }
    if (this.stopped || signal.aborted) {
      return;
    }
    if (!event) {
      // Not published, not upstream, or the relay never answered — none of
      // which is distinguishable from here, and all of which come out as the
      // abbreviated chip the reference was before this feature existed.
      this.setEmbed(target.key, { status: 'missing' });
      this.pumpEmbedQueue();
      return;
    }
    // Classified for the same reason profile deliveries are: the cache/upstream
    // counters must describe the same population of events the widget renders.
    this.relayHost?.metrics.classifyDelivered(event.id);
    this.setEmbed(target.key, { status: 'ready', event });
    // The nested card names its author, so it needs the same kind 0 the
    // timeline's own cards do.
    this.requestProfile(event.pubkey);
    // A nested card is faded until the relay has vouched for it, exactly like a
    // timeline card, so its verdict has to be polled for too.
    this.scheduleValidationRefresh();
    this.pumpEmbedQueue();
  }

  /** Record one embed's progress, replacing the map so the view re-renders. */
  private setEmbed(key: string, embed: EmbeddedEvent): void {
    const embeds = new Map(this.state.embeds);
    embeds.set(key, embed);
    this.patch({ embeds });
  }

  /**
   * Abandon every lookup, in flight or queued.
   *
   * `requestedEmbeds` goes with them: the cards that asked are being torn down,
   * and a widget that is resumed with {@link applyFilter} must be able to ask
   * again.
   */
  private closeEmbeds(): void {
    this.pendingEmbeds = [];
    this.requestedEmbeds = new Set();
    this.embedAbort.abort();
  }

  /**
   * Publish what a {@link FilterSource} reported about its resolution.
   *
   * `dropped` is acted on rather than merely displayed: the subscription is
   * asking for a population the cache can no longer vouch for, and since the
   * follow list is fetched once and never re-read, leaving it running would
   * keep that timeline on screen — and refilling with it — until unmount.
   */
  private applyFollows(follows: FollowsState): void {
    if (follows.status !== 'dropped') {
      this.patch({ follows });
      return;
    }
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.patch({
      follows,
      events: [],
      origins: new Map(),
      validationStatuses: new Map(),
      eose: false,
    });
  }

  /**
   * Poll until the cache either vouches for an event or stops holding it.
   *
   * Reuses the relay's own lazy-validation results, so nothing is verified here
   * — the widget does no crypto.
   *
   * **`unknown` does not prove forgery.** The relay reports it for any id that
   * has no row: deleted as invalid, deleted by NIP-09, evicted, never ingested,
   * and — because the storage layer answers a read failure by calling
   * everything `unknown` — a broken IndexedDB too. Signature failure is only
   * the most likely of those for an event that was in the cache a moment ago,
   * so what this reports is "the cache no longer holds it", and the caller says
   * exactly that rather than naming a cause it cannot know.
   *
   * `validated` ends the watch: the relay has checked the signature, which is
   * the question actually being asked.
   *
   * An event that never appears at all is reported too, after
   * {@link VALIDATION_WATCH_MAX_MISSES} tries. Waiting for a `pending` sighting
   * first would look safer but silently loses the case that matters most: lazy
   * validation runs every 5s and can delete a forged event *before* the first
   * poll, leaving a status that is `unknown` from the outset and a timeline
   * built on it running untouched for the rest of the session.
   */
  private watchValidation(eventId: string, onDropped: () => void): void {
    const { signal } = this.filterSourceAbort;
    let misses = 0;

    const poll = async (): Promise<void> => {
      const host = this.relayHost;
      if (!host || this.stopped || signal.aborted) {
        return;
      }
      let statuses: Map<string, ValidationStatus>;
      try {
        statuses = await fetchValidationStatuses(host.relay, [eventId]);
      } catch {
        // A failed lookup is not evidence of anything; try again.
        schedule();
        return;
      }
      if (this.stopped || signal.aborted) {
        return;
      }
      const status = statuses.get(eventId);
      if (status === 'validated') {
        return;
      }
      if (status === 'pending') {
        // Still queued for verification, so the verdict is still to come.
        misses = 0;
        schedule();
        return;
      }
      misses += 1;
      if (misses >= VALIDATION_WATCH_MAX_MISSES) {
        onDropped();
        return;
      }
      schedule();
    };

    const schedule = (): void => {
      clearTimeout(this.validationWatchTimer);
      this.validationWatchTimer = setTimeout(() => {
        this.validationWatchTimer = undefined;
        void poll();
      }, this.options.validationPollIntervalMs ?? VALIDATION_POLL_INTERVAL_MS);
    };
    signal.addEventListener('abort', () => clearTimeout(this.validationWatchTimer), { once: true });

    void poll();
  }

  /** Coalesce the lookups triggered by a burst of incoming events. */
  private scheduleValidationRefresh(): void {
    clearTimeout(this.validationFetchTimer);
    this.validationFetchTimer = setTimeout(() => {
      this.validationFetchTimer = undefined;
      void this.refreshValidationStatuses();
    }, VALIDATION_FETCH_DEBOUNCE_MS);
  }

  private async refreshValidationStatuses(): Promise<void> {
    const host = this.relayHost;
    // Quoted events count: a nested card is faded until the relay vouches for
    // it, so a timeline that is still empty but has already resolved a quote
    // has something to ask about.
    const ids = new Set(this.state.events.map((event) => event.id));
    for (const embed of this.state.embeds.values()) {
      if (embed.event) {
        ids.add(embed.event.id);
      }
    }
    if (!host || ids.size === 0) {
      return;
    }
    let statuses: Map<string, ValidationStatus>;
    try {
      statuses = await fetchValidationStatuses(host.relay, [...ids]);
    } catch {
      // A failed lookup only costs us the ✓ badges; the timeline is unaffected.
      return;
    }
    if (this.stopped) {
      return;
    }
    this.patch({ validationStatuses: statuses });

    // Only `pending` can still change: `unknown` is terminal (never stored,
    // deleted as invalid, or evicted), so it must not keep polling alive.
    clearTimeout(this.validationPollTimer);
    this.validationPollTimer = undefined;
    if (hasPending(statuses)) {
      this.validationPollTimer = setTimeout(() => {
        this.validationPollTimer = undefined;
        void this.refreshValidationStatuses();
      }, VALIDATION_POLL_INTERVAL_MS);
    }
  }

  /**
   * Whether the socket is down but on its way back.
   *
   * A REQ issued now is not lost — rx-nostr holds it and sends it once the
   * connection returns — so a filter change mid-reconnect should go through
   * quietly rather than being refused with an error the reader would be stuck
   * on after the connection recovered.
   */
  private isRecovering(): boolean {
    return this.state.status === 'connecting' || this.state.status === 'reconnecting';
  }

  private clearTimers(): void {
    clearTimeout(this.validationFetchTimer);
    clearTimeout(this.validationPollTimer);
    this.validationFetchTimer = undefined;
    this.validationPollTimer = undefined;
  }

  private patch(partial: Partial<TimelineState>): void {
    this.state = { ...this.state, ...partial };
    this.options.onChange(this.state);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
