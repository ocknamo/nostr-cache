/**
 * Framework-agnostic driver for a timeline: acquires the shared in-page relay,
 * speaks NIP-01 to it over an emulated WebSocket, and publishes a snapshot of
 * the resulting state to a listener.
 *
 * Keeping this out of the Svelte component is what lets the custom element, the
 * iframe page and the demo site all render the exact same behaviour, and lets
 * the interesting parts be tested without a DOM.
 *
 * The lookups the widget opens for itself — author profiles, quoted events,
 * reactions and threads — live in `timeline/`, each owning its subscriptions
 * and its slice of {@link TimelineState}. What is left here is the timeline's
 * own subscription and the lifecycle the four share.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { CacheMetrics, EventOrigin } from './cache-metrics.ts';
import type { EmbedTarget, EmbeddedEvent } from './note-embeds.ts';
import type { PostTarget } from './post-target.ts';
import type { Profile } from './profile.ts';
import { type ConnectionStatus, RelayConnection } from './relay-connection.ts';
import { type RelayHost, type RelayHostConfig, acquireRelayHost } from './relay-host.ts';
import { type RequestDurations, RequestTimer } from './request-timer.ts';
import { insertEvent } from './timeline-utils.ts';
import { EmbedLoader } from './timeline/embed-loader.ts';
import type { LookupContext } from './timeline/lookup-context.ts';
import { ProfileLoader } from './timeline/profile-loader.ts';
import { ReactionWatcher } from './timeline/reaction-watcher.ts';
import { type ReplyRequestOptions, ReplyWatcher } from './timeline/reply-watcher.ts';
import { ValidationTracker } from './timeline/validation-tracker.ts';
import type { ValidationStatus } from './validation-status.ts';

export type { ReplyRequestOptions };

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
   * the cache stops holding it. See `ValidationTracker.watch` for what that
   * does and does not prove.
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

export interface TimelineState {
  status: ConnectionStatus;
  events: NostrEvent[];
  origins: Map<string, EventOrigin>;
  validationStatuses: Map<string, ValidationStatus>;
  /** Author profiles (kind 0) fetched so far, keyed by pubkey. */
  profiles: Map<string, Profile>;
  /** Events quoted by a `nostr:` reference in some body, keyed by `embedKey`. */
  embeds: Map<string, EmbeddedEvent>;
  /** Kind 7 reactions (NIP-25), keyed by {@link PostTarget.key} and newest first. */
  reactions: Map<string, NostrEvent[]>;
  /** Kind 1 replies collected for a post, keyed by {@link PostTarget.key} and newest first. */
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
  /** How long a profile lookup stays open after EOSE; see `profile-loader.ts`. */
  profileEoseGraceMs?: number;
  /** Seconds between validation re-checks, as milliseconds. */
  validationPollIntervalMs?: number;
  /** Called with a fresh snapshot whenever anything changes. */
  onChange: (state: TimelineState) => void;
}

export class TimelineController {
  private readonly connection: RelayConnection;
  private relayHost?: RelayHost;
  private readonly profiles: ProfileLoader;
  private readonly embeds: EmbedLoader;
  private readonly reactions: ReactionWatcher;
  private readonly replies: ReplyWatcher;
  private readonly validation: ValidationTracker;
  /**
   * Which post the post-scoped watches belong to, as a counter.
   *
   * Only {@link startPost} reads it, and only to find out whether the post it
   * was booting for is still the one on screen — see there.
   */
  private postGeneration = 0;
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
  /**
   * Cancels an in-flight {@link FilterSource}.
   *
   * A source blocks for up to its own watchdog (5s) and `stop()` can land at
   * any point in there. The subscriptions a source opens are its own, outside
   * this class's bookkeeping, so nothing else would close them.
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
          // A reconnect gives the queues somewhere to drain to again. The
          // timeline REQ needs no help — rx-nostr re-sends the subscriptions it
          // was holding — but the lookups below are opened one at a time by
          // this class, so the ones parked while the socket was down have to be
          // started from here.
          this.patch({ error: undefined });
          this.profiles.pump();
          this.embeds.pump();
          this.reactions.pump();
          this.replies.pump();
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

    const ctx: LookupContext = {
      connection: this.connection,
      isActive: () => !this.stopped && !this.suspended,
      classifyDelivered: (eventId) => {
        this.relayHost?.metrics.classifyDelivered(eventId);
      },
    };
    this.profiles = new ProfileLoader({
      ctx,
      eoseGraceMs: options.profileEoseGraceMs,
      onChange: (profiles) => this.patch({ profiles }),
    });
    this.embeds = new EmbedLoader({
      ctx,
      onResolved: (event) => {
        this.profiles.request(event.pubkey);
        // A nested card is faded until the relay has vouched for it, exactly
        // like a timeline card, so its verdict has to be polled for too.
        this.validation.schedule();
      },
      onChange: (embeds) => this.patch({ embeds }),
    });
    this.reactions = new ReactionWatcher({
      ctx,
      onChange: (reactions) => this.patch({ reactions }),
    });
    this.replies = new ReplyWatcher({
      ctx,
      rootId: () => this.state.events[0]?.id,
      onIngested: () => this.validation.schedule(),
      onChange: (replies) => this.patch({ replies }),
    });
    this.validation = new ValidationTracker({
      relay: () => this.relayHost?.relay,
      ids: () => this.renderedEventIds(),
      isRunning: () => !this.stopped,
      pollIntervalMs: options.validationPollIntervalMs,
      onChange: (validationStatuses) => this.patch({ validationStatuses }),
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
        watchValidation: (eventId, onDropped) =>
          this.validation.watch(eventId, this.filterSourceAbort.signal, onDropped),
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

  /**
   * Boot for a single post: open its own REQ first, then the watches around it.
   *
   * The order is why this exists rather than a `start()` with a
   * {@link watchPost} beside it. The post itself is one primary-key lookup; the
   * two watches read every row carrying the post's id in an `e` tag, so what
   * they cost grows with how much the post was answered. The relay reads for
   * both on the page's own thread, so the REQ that arrives first is served
   * first — and the one the reader is waiting to see is the post.
   *
   * The measured effect is modest on its own; what made this page slow was the
   * filter shape of the watches rather than their place in the queue (see
   * `storage.md` §4.1.1).
   */
  async startPost(target: PostTarget, wants: PostWatches = {}): Promise<void> {
    this.postGeneration += 1;
    const generation = this.postGeneration;
    await this.start([target.filter]);
    // The boot takes as long as the relay does, and the element can be pointed
    // somewhere else in that window — a page setting `event-id` from script, or
    // turning `show-replies` off. A later {@link showPost} has already closed
    // the watches by then, and opening these would leave the *previous* post's
    // kind 7 and kind 1 subscriptions running with nothing to close them.
    if (generation !== this.postGeneration) {
      return;
    }
    // Nothing was asked of the relay (it failed to boot, or the socket is
    // down), so there is no post for these to be about — and the watches
    // remember what they have been asked for, so queueing them here would make
    // the omission permanent.
    if (!this.currentSubId) {
      return;
    }
    this.watchPost(target, wants);
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
    this.closeLookups();
    this.validation.clearTimers();
  }

  /**
   * Close the subscription and release this widget's claim on the relay. Safe
   * to call more than once, and safe to call while {@link start} is in flight.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStopped();
    this.filterSourceAbort.abort();
    this.validation.clearTimers();
    this.closeLookups();
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.connection.disconnect();
    const host = this.relayHost;
    this.relayHost = undefined;
    await host?.release();
  }

  /**
   * A live lookup of any kind keeps reading through to upstream and refilling
   * the very cache a `suspend()` is about to measure cold.
   */
  private closeLookups(): void {
    this.profiles.close();
    this.embeds.close();
    this.reactions.close();
    this.replies.close();
  }

  private subscribe(filters: Filter[]): void {
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.validation.clearTimers();
    this.suspended = false;
    if (this.filterSourceAbort.signal.aborted && !this.stopped) {
      // Re-arm after a suspend, so a resumed controller can run a filter source
      // (and the validation watch that comes with it) again.
      this.filterSourceAbort = new AbortController();
    }
    this.profiles.reset();
    this.embeds.reset();
    // Reactions and replies deliberately survive a re-subscribe. Unlike
    // profiles and quoted events they are not derived from what is on screen —
    // the caller named the post — so a new filter says nothing about whether
    // they are still wanted. {@link showPost} is the caller that does know.
    // Timings are per subscription id and never revisited once replaced.
    this.timer.clear();
    this.patch({
      events: [],
      origins: new Map(),
      validationStatuses: new Map(),
      embeds: this.embeds.embedMap(),
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
        this.validation.schedule();
      },
      onEose: () => {
        this.timer.markEose(subId);
        this.patch({ eose: true });
        this.validation.schedule();
      },
      onClosed: (reason) => {
        this.patch({ error: `購読が閉じられました${reason ? `: ${reason}` : ''}` });
      },
    });
  }

  /** Fetch one author's profile; see `profile-loader.ts`. */
  requestProfile(pubkey: string): void {
    this.profiles.request(pubkey);
  }

  /** Fetch an event quoted by a `nostr:` reference; see `embed-loader.ts`. */
  requestEmbed(target: EmbedTarget): void {
    this.embeds.request(target);
  }

  /** Watch one post's reactions; see `reaction-watcher.ts`. */
  requestReactions(target: PostTarget, limit?: number): void {
    this.reactions.request(target, limit);
  }

  /** Watch the thread under one post; see `reply-watcher.ts`. */
  requestReplies(target: PostTarget, options: ReplyRequestOptions = {}): void {
    this.replies.request(target, options);
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
    // Supersedes a {@link startPost} still waiting on the relay, whose watches
    // are about the post this one is replacing.
    this.postGeneration += 1;
    this.reactions.close();
    this.replies.close();
    this.applyFilter([target.filter]);
    this.reactions.clearEvents();
    this.replies.clearEvents();
    this.patch({ reactions: this.reactions.reactionMap(), replies: this.replies.replyMap() });
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
   * Every id the widget has rendered a card for. Quoted events and replies
   * count: they are faded until the relay vouches for them, so a timeline that
   * is still empty but has already resolved a quote has something to ask about.
   */
  private renderedEventIds(): Set<string> {
    const ids = new Set(this.state.events.map((event) => event.id));
    for (const embed of this.state.embeds.values()) {
      if (embed.event) {
        ids.add(embed.event.id);
      }
    }
    for (const replies of this.state.replies.values()) {
      for (const reply of replies) {
        ids.add(reply.id);
      }
    }
    return ids;
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

  private patch(partial: Partial<TimelineState>): void {
    this.state = { ...this.state, ...partial };
    this.options.onChange(this.state);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
