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
import type { PostTarget } from './post-target.ts';
import { type Profile, parseProfileContent } from './profile.ts';
import { MAX_REACTIONS, parseReaction } from './reactions.ts';
import { type ConnectionStatus, RelayConnection } from './relay-connection.ts';
import { type RelayHost, type RelayHostConfig, acquireRelayHost } from './relay-host.ts';
import {
  DEFAULT_REPLIES_LIMIT,
  DEFAULT_REPLY_DEPTH,
  MAX_REPLIES,
  MAX_REPLY_DEPTH,
  acceptsReply,
} from './reply-tree.ts';
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
 * REQ, the four profile lookups above, and — on a post detail — one reaction
 * subscription plus one per thread level (`MAX_REPLY_DEPTH`), so the widget's
 * ceiling is thirteen. Headroom matters here because a nested card that fails
 * for want of a subscription slot is indistinguishable from one whose event
 * does not exist.
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
 * Backfill size for one reaction REQ. Well under {@link MAX_REACTIONS}, which
 * is where the ones already received stop accumulating; a live subscription
 * goes on delivering past it.
 */
const DEFAULT_REACTION_LIMIT = 200;

/**
 * Ids carried by one level's REQ.
 *
 * A wide thread would otherwise put every reply of the level above into a
 * single filter, and the relay matches `#e` against each of them. What does not
 * fit is not retried later — a level is asked once — so a very wide thread is
 * read narrower rather than slower.
 */
const MAX_REPLY_IDS_PER_LEVEL = 100;

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

/** The watches a post detail keeps open, as {@link TimelineController.watchPost} reads them. */
export interface PostWatches {
  reactions?: { limit?: number };
  replies?: ReplyRequestOptions;
}

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
  /** Pending {@link TimelineController.advanceReplyLevel}, if a level has ended. */
  advance?: ReturnType<typeof setTimeout>;
}

export interface TimelineState {
  status: ConnectionStatus;
  events: NostrEvent[];
  origins: Map<string, EventOrigin>;
  validationStatuses: Map<string, ValidationStatus>;
  /** Author profiles (kind 0) fetched so far, keyed by pubkey. */
  profiles: Map<string, Profile>;
  /** Events quoted by a `nostr:` reference in some body, keyed by `embedKey`. */
  embeds: Map<string, EmbeddedEvent>;
  /**
   * Kind 7 reactions (NIP-25), keyed by {@link PostTarget.key} and newest
   * first. Raw events rather than a summary, so a view re-deriving through
   * `reactions.ts` stays correct as more arrive.
   */
  reactions: Map<string, NostrEvent[]>;
  /**
   * Kind 1 replies collected for a post, keyed by {@link PostTarget.key} and
   * newest first. Raw events rather than a tree, for the same reason
   * {@link TimelineState.reactions} holds raw events: a view re-deriving
   * through `reply-tree.ts` stays correct as more arrive.
   */
  replies: Map<string, NostrEvent[]>;
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
  private pendingEmbeds: EmbedTarget[] = [];
  private embedsInFlight = 0;
  /**
   * Cancels the in-flight embed lookups.
   *
   * Separate from {@link filterSourceAbort} because these outlive a filter
   * source and are torn down on a different schedule — a `suspend()` must end
   * them, and a later `applyFilter()` must be able to start new ones.
   */
  private embedAbort = new AbortController();
  /**
   * Live reaction subscriptions, by {@link PostTarget.key}. One REQ per post,
   * which fits the relay's per-client cap of 20 alongside the timeline REQ,
   * four profile lookups and two embed lookups.
   */
  private readonly reactionSubs = new Map<string, string>();
  /** Targets waiting for the socket to come back up. */
  private pendingReactions: Array<{ target: PostTarget; limit: number }> = [];
  /** Targets a subscription has been opened for, so a repeat costs nothing. */
  private requestedReactions = new Set<string>();
  private reactionSeq = 0;
  /**
   * Thread subscriptions, by {@link PostTarget.key}. One REQ per level rather
   * than one per reply: NIP-10 lets a grandchild name only its own parent and
   * the thread root, so a single `#e` on the post cannot reach past the first
   * level, but the level above always knows the ids the next one answers.
   */
  private readonly replyWatches = new Map<string, ReplyWatch>();
  private pendingReplies: ReplyRequest[] = [];
  private requestedReplies = new Set<string>();
  private replySeq = 0;
  private readonly timer = new RequestTimer();
  private readonly options: TimelineControllerOptions;
  private state: TimelineState = {
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    embeds: new Map(),
    reactions: new Map(),
    replies: new Map(),
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
          this.pumpReactionQueue();
          this.pumpReplyQueue();
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
    // A live reaction or reply REQ would go on refilling the cache the caller is
    // about to measure cold — the very thing suspend() exists to stop.
    this.closeReactions();
    this.closeReplies();
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
    this.closeReactions();
    this.closeReplies();
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
    // Reactions and replies deliberately survive a re-subscribe. Unlike profiles
    // and quoted events they are not derived from what is on screen — the caller
    // named the post — so a new filter says nothing about whether they are still
    // wanted. {@link showPost} is the caller that does know, and clears them.
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
   * Fetch an event quoted by a `nostr:` reference (NIP-27).
   *
   * Called by a card when it scrolls into view, for the same reason
   * {@link requestProfile} is: a timeline of 500 events must only pay for the
   * quotes a reader can actually see. Nesting is bounded by the caller — see
   * `note-embeds.ts`.
   *
   * Repeat calls for the same target are ignored, which is request
   * de-duplication and not a cache in front of the relay's: the same reference
   * appears on every card that quotes it, and those cards scroll in and out.
   */
  requestEmbed(target: EmbedTarget): void {
    if (this.stopped || this.suspended) {
      return;
    }
    if (this.requestedEmbeds.has(target.key)) {
      return;
    }
    this.requestedEmbeds.add(target.key);
    // Before the lookup starts, so the card has something to render while it
    // waits in the queue below.
    this.setEmbed(target.key, { status: 'loading' });
    this.pendingEmbeds.push(target);
    this.pumpEmbedQueue();
  }

  /**
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
    this.requestProfile(event.pubkey);
    // A nested card is faded until the relay has vouched for it, exactly like a
    // timeline card, so its verdict has to be polled for too.
    this.scheduleValidationRefresh();
    this.pumpEmbedQueue();
  }

  /** A fresh Map rather than a mutation, so the view re-renders. */
  private setEmbed(key: string, embed: EmbeddedEvent): void {
    const embeds = new Map(this.state.embeds);
    embeds.set(key, embed);
    this.patch({ embeds });
  }

  /**
   * `requestedEmbeds` is dropped with them: the cards that asked are being torn
   * down, and a widget resumed with {@link applyFilter} must be able to ask
   * again.
   */
  private closeEmbeds(): void {
    this.pendingEmbeds = [];
    this.requestedEmbeds = new Set();
    this.embedAbort.abort();
  }

  /**
   * Watch one post's reactions (NIP-25 kind 7).
   *
   * For `<nostr-post>`, never a timeline — that would be one REQ per card.
   * Not viewport-triggered like {@link requestProfile} and {@link requestEmbed}:
   * the post it names is the whole reason the widget exists.
   *
   * The subscription stays open, so a reaction that lands while the reader is
   * on the page appears without a reload.
   *
   * @param limit How many reactions to backfill; more may arrive live.
   */
  requestReactions(target: PostTarget, limit: number = DEFAULT_REACTION_LIMIT): void {
    if (this.stopped || this.suspended) {
      return;
    }
    if (this.requestedReactions.has(target.key)) {
      return;
    }
    this.requestedReactions.add(target.key);
    this.pendingReactions.push({ target, limit });
    this.pumpReactionQueue();
  }

  /**
   * Nothing is opened while the socket is down. rx-nostr would buffer the REQ,
   * but going through the queue the `connected` handler already pumps keeps one
   * rule for every lookup this class opens itself.
   */
  private pumpReactionQueue(): void {
    if (this.stopped || this.suspended || !this.connection.isConnected) {
      return;
    }
    while (this.pendingReactions.length > 0) {
      const next = this.pendingReactions.shift();
      if (next !== undefined) {
        this.openReactionRequest(next.target, next.limit);
      }
    }
  }

  private openReactionRequest(target: PostTarget, limit: number): void {
    this.reactionSeq += 1;
    const subId = `reactions-${this.reactionSeq}`;
    this.reactionSubs.set(target.key, subId);

    // NIP-25 points at an addressable post with `a` and a plain one with `e`;
    // asking with the wrong tag matches nothing.
    const filter: Filter =
      target.match.address !== undefined
        ? { kinds: [7], '#a': [target.match.address], limit }
        : { kinds: [7], '#e': [target.match.id ?? target.key], limit };

    this.connection.subscribe(subId, [filter], {
      onEvent: (event) => this.ingestReaction(target, event),
      onEose: () => {
        // Nothing to do — the subscription stays open on purpose. Handled
        // explicitly so nobody goes looking for the close that is not here.
      },
      onClosed: (reason) => {
        // Not the widget's `error`: the post is still on screen and still
        // correct, and a banner over it would say the post failed when only its
        // reaction count stopped updating.
        console.warn(`[nostr-post] reaction subscription closed${reason ? `: ${reason}` : ''}`);
        this.reactionSubs.delete(target.key);
        // Released so a caller can ask again; without this the guard in
        // `requestReactions` would make the closure permanent. Not re-queued
        // here — a relay that refused this REQ would refuse the replacement,
        // and the queue is pumped synchronously, so that would spin.
        this.requestedReactions.delete(target.key);
      },
    });
  }

  /**
   * Filtered here rather than in the view because the cap is here: a relay
   * matches `#e` against any `e` tag, so under a busy thread the reactions to
   * *replies* would fill {@link MAX_REACTIONS} and push out this post's own.
   */
  private ingestReaction(target: PostTarget, event: NostrEvent): void {
    if (!parseReaction(event, target.match)) {
      return;
    }
    // As for profile and embed deliveries: the cache/upstream counters must
    // describe the same population of events the widget renders.
    this.relayHost?.metrics.classifyDelivered(event.id);
    const reactions = new Map(this.state.reactions);
    const current = reactions.get(target.key) ?? [];
    const next = insertEvent(current, event, MAX_REACTIONS);
    if (next === current) {
      // A duplicate delivery; a new Map would re-render every chip for nothing.
      return;
    }
    reactions.set(target.key, next);
    this.patch({ reactions });
  }

  /**
   * `requestedReactions` goes with the subscriptions so a resumed controller can
   * be asked again — by the original caller, since nothing here re-issues it.
   * What arrived stays in state: blanking the chips would look like the
   * reactions went away.
   */
  private closeReactions(): void {
    this.pendingReactions = [];
    this.requestedReactions = new Set();
    for (const [key, subId] of [...this.reactionSubs]) {
      this.reactionSubs.delete(key);
      this.connection.unsubscribe(subId);
    }
  }

  /**
   * Watch the thread under one post (kind 1 replies, NIP-10).
   *
   * Like {@link requestReactions} and unlike {@link requestProfile}, this is
   * not viewport-triggered: the post it names is the whole reason the widget
   * exists. The levels open as the one above them reaches EOSE, so a thread
   * that is only one deep costs one REQ.
   */
  requestReplies(target: PostTarget, options: ReplyRequestOptions = {}): void {
    if (this.stopped || this.suspended || this.requestedReplies.has(target.key)) {
      return;
    }
    this.requestedReplies.add(target.key);
    this.pendingReplies.push({
      target,
      limit: options.limit ?? DEFAULT_REPLIES_LIMIT,
      maxDepth: Math.min(Math.max(1, options.maxDepth ?? DEFAULT_REPLY_DEPTH), MAX_REPLY_DEPTH),
    });
    this.pumpReplyQueue();
  }

  /** Held until the socket is up, as every lookup this class opens itself is. */
  private pumpReplyQueue(): void {
    if (this.stopped || this.suspended || !this.connection.isConnected) {
      return;
    }
    while (this.pendingReplies.length > 0) {
      const next = this.pendingReplies.shift();
      if (next !== undefined) {
        const watch: ReplyWatch = {
          ...next,
          subs: [],
          opened: 0,
          asked: new Set(),
          frontier: [],
        };
        this.replyWatches.set(next.target.key, watch);
        this.openReplyLevel(watch);
      }
    }
  }

  /**
   * @param ids The events this level answers. Absent for the first level, which
   *   asks about the post itself — by `a` when it is addressable, because that
   *   is what a reply to an article names.
   */
  private openReplyLevel(watch: ReplyWatch, ids?: string[]): void {
    const { target, limit } = watch;
    this.replySeq += 1;
    const subId = `replies-${this.replySeq}`;
    watch.subs.push(subId);
    watch.opened += 1;

    const filter: Filter =
      ids !== undefined
        ? { kinds: [1], '#e': ids, limit }
        : target.match.address !== undefined
          ? { kinds: [1], '#a': [target.match.address], limit }
          : { kinds: [1], '#e': [target.match.id ?? target.key], limit };

    this.connection.subscribe(subId, [filter], {
      onEvent: (event) => this.ingestReply(watch, event),
      // Deferred by a turn rather than run here: events and EOSE reach this
      // class down two different rx-nostr observables, so the last deliveries
      // of a level can still be queued when its EOSE lands. Reading the
      // frontier now would ask the next level about a short list — or, for a
      // level whose replies all arrived that way, about nothing at all. The
      // profile lookups defer their close for the same reason
      // ({@link finishAfterEose}).
      onEose: () => {
        clearTimeout(watch.advance);
        watch.advance = setTimeout(() => this.advanceReplyLevel(watch), 0);
      },
      onClosed: (reason) => {
        // Not the widget's `error`, for the reason `openReactionRequest` gives:
        // the post is still on screen and still correct.
        console.warn(`[nostr-post] reply subscription closed${reason ? `: ${reason}` : ''}`);
        watch.subs = watch.subs.filter((id) => id !== subId);
        // `requestedReplies` deliberately keeps its entry, unlike the reaction
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
   * events it has accepted — the same property {@link PROFILE_EOSE_GRACE_MS}
   * rests on.
   *
   * Replies that arrive *after* their level's EOSE are kept and rendered, but
   * do not open a level of their own: a live thread would otherwise re-open a
   * subscription every time someone answered.
   */
  private advanceReplyLevel(watch: ReplyWatch): void {
    watch.advance = undefined;
    // Cleared before the guards: past the last level `ingestReply` goes on
    // adding to it, and nothing would ever drain it again.
    const arrived = watch.frontier.filter((id) => !watch.asked.has(id));
    watch.frontier = [];
    if (this.stopped || this.suspended || watch.opened >= watch.maxDepth) {
      return;
    }
    const ids = arrived.slice(0, MAX_REPLY_IDS_PER_LEVEL);
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      watch.asked.add(id);
    }
    this.openReplyLevel(watch, ids);
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
  private ingestReply(watch: ReplyWatch, event: NostrEvent): void {
    const current = this.state.replies.get(watch.target.key) ?? [];
    const held = new Set(current.map((reply) => reply.id));
    const accepted = acceptsReply(event, watch.target.match, {
      known: held,
      // The addressable post itself, which its direct replies name alongside
      // the coordinate. Undefined until the post has arrived, which is also
      // when the thread subscription has nothing to be about yet.
      ...(this.state.events[0] ? { rootId: this.state.events[0].id } : {}),
    });
    if (!accepted) {
      return;
    }
    this.relayHost?.metrics.classifyDelivered(event.id);
    const next = insertEvent(current, event, MAX_REPLIES);
    if (next === current) {
      return;
    }
    const replies = new Map(this.state.replies);
    replies.set(watch.target.key, next);
    watch.frontier.push(event.id);
    this.patch({ replies });
    // Replies are cards like any other, and the relay verifies signatures in
    // the background; without this they would stay dimmed for good.
    this.scheduleValidationRefresh();
  }

  /**
   * The subscriptions go; what arrived stays in state, as with reactions —
   * blanking the thread would look like the replies had been deleted.
   */
  private closeReplies(): void {
    this.pendingReplies = [];
    this.requestedReplies = new Set();
    for (const [key, watch] of [...this.replyWatches]) {
      this.replyWatches.delete(key);
      clearTimeout(watch.advance);
      for (const subId of watch.subs) {
        this.connection.unsubscribe(subId);
      }
    }
  }

  /**
   * Point the widget at a different post, keeping the relay and the connection.
   *
   * Not {@link applyFilter}: the reactions and the thread belong to the post
   * rather than to the timeline, so leaving them open would leak up to
   * `MAX_REPLY_DEPTH + 1` subscriptions per hop — a few steps up a thread and
   * the reader is over the relay's per-client cap. Their collected events go
   * with them, because the alternative is a map that grows with every post
   * visited and the cache answers the way back from IndexedDB anyway.
   */
  showPost(target: PostTarget, wants: PostWatches = {}): void {
    this.closeReactions();
    this.closeReplies();
    this.applyFilter([target.filter]);
    this.patch({ reactions: new Map(), replies: new Map() });
    this.watchPost(target, wants);
  }

  /**
   * Open whichever of the two post-scoped watches the caller asked for.
   *
   * The presence of the key is the request and the value is only its settings,
   * so "watch the reactions, at whatever the default backfill is" is sayable —
   * an absent limit must not read as an absent request.
   */
  watchPost(target: PostTarget, wants: PostWatches): void {
    if (wants.reactions !== undefined) {
      this.requestReactions(target, wants.reactions.limit);
    }
    if (wants.replies !== undefined) {
      this.requestReplies(target, wants.replies);
    }
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
    // So does a reply: the thread is rendered with the same cards as the post,
    // and without this every one of them would stay dimmed for good.
    for (const replies of this.state.replies.values()) {
      for (const reply of replies) {
        ids.add(reply.id);
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
