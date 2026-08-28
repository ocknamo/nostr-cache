/**
 * Framework-agnostic driver for a timeline: acquires the shared in-page relay,
 * speaks NIP-01 to it, and publishes a snapshot of the result to a listener.
 * Living outside the Svelte component is what lets the custom element, the
 * iframe page and the demo site share it, and lets it be tested without a DOM.
 *
 * The lookups the widget opens for itself live in `timeline/`, each owning its
 * subscriptions and its slice of {@link TimelineState}.
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

export interface FollowsState {
  /**
   * `missing` means no subscription was opened at all; `dropped` means the
   * event the authors were built from is no longer in the cache.
   */
  status: 'resolving' | 'ready' | 'missing' | 'dropped';
  /** Authors on the timeline filter, the subject included when it is. */
  count: number;
  /** Follow-list entries dropped by `max-follows`. */
  truncated: number;
}

/**
 * Deliberately narrow: the controller stays ignorant of what a source fetches.
 * Teaching it NIP-02 instead would make every test of follow-list parsing boot
 * a relay first.
 */
export interface FilterSourceContext {
  connection: RelayConnection;
  /** Aborts on `stop()` / `suspend()`; check it after every await. */
  signal: AbortSignal;
  setFollows: (follows: FollowsState) => void;
  /** Calls back if the cache stops holding the event; see `ValidationTracker`. */
  watchValidation: (eventId: string, onDropped: () => void) => void;
}

/**
 * Filters resolved at runtime, from data only a relay can supply. An empty
 * array means "do not subscribe at all": the source found nothing safe to ask
 * for, and the controller must not invent a fallback filter.
 */
export type FilterSource = (context: FilterSourceContext) => Promise<Filter[]>;

export interface PostWatches {
  reactions?: { limit?: number };
  replies?: ReplyRequestOptions;
}

export interface TimelineState {
  status: ConnectionStatus;
  events: NostrEvent[];
  origins: Map<string, EventOrigin>;
  validationStatuses: Map<string, ValidationStatus>;
  /** Keyed by pubkey. */
  profiles: Map<string, Profile>;
  /** Keyed by `embedKey`. */
  embeds: Map<string, EmbeddedEvent>;
  /** Keyed by {@link PostTarget.key}, newest first. */
  reactions: Map<string, NostrEvent[]>;
  /** Keyed by {@link PostTarget.key}, newest first. */
  replies: Map<string, NostrEvent[]>;
  eose: boolean;
  error?: string;
  /** Set only by a {@link FilterSource} that reports one. */
  follows?: FollowsState;
}

export interface TimelineControllerOptions {
  /** Relay settings. The first widget on a page wins — see `relay-host.ts`. */
  host?: RelayHostConfig;
  maxEvents?: number;
  /** See `profile-loader.ts`. */
  profileEoseGraceMs?: number;
  /** See `validation-tracker.ts`; applies to the follow-list watch only. */
  validationPollIntervalMs?: number;
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
  /** Lets {@link startPost} tell whether the post it booted for is still on screen. */
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
   * Cancels an in-flight {@link FilterSource}, which blocks for up to 5s and
   * opens subscriptions nothing else here would close. Replaced rather than
   * reused, so a resumed controller is not left permanently aborted.
   */
  private filterSourceAbort = new AbortController();
  private stopped = false;
  /** Whether the connection ever came up, so a later error means it was lost. */
  private connectedOnce = false;
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
          // rx-nostr re-sends the timeline REQ itself; the lookups parked
          // while the socket was down have to be restarted from here.
          this.patch({ error: undefined });
          this.profiles.pump();
          this.embeds.pump();
          this.reactions.pump();
          this.replies.pump();
        } else if (status === 'error' && this.connectedOnce) {
          // Reconnection gave up, or the widget shows a stale timeline with
          // nothing to say so. A failed *first* connection is start()'s.
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
        // A nested card is faded until the relay vouches for it, like any other.
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

  get host(): RelayHost | undefined {
    return this.relayHost;
  }

  get metrics(): CacheMetrics | undefined {
    return this.relayHost?.metrics;
  }

  durations(): RequestDurations | undefined {
    return this.currentSubId ? this.timer.durations(this.currentSubId) : undefined;
  }

  /**
   * Boot the relay, if this is the first widget, and open the subscription.
   *
   * @param source Filters, which travel as one REQ so anything matching any of
   *   them lands in the same timeline, or a {@link FilterSource}.
   */
  async start(source: Filter[] | FilterSource): Promise<void> {
    try {
      this.relayHost = await acquireRelayHost(this.options.host);
    } catch (error) {
      this.patch({ status: 'error', error: `リレーの起動に失敗しました: ${message(error)}` });
      return;
    }
    // stop() can land while the relay is booting.
    if (this.stopped) {
      await this.relayHost.release();
      this.relayHost = undefined;
      return;
    }
    try {
      // stop() detaches the socket's handlers, so a connect() in flight would
      // never settle.
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
      // `follows` goes with it: a source that threw will not report again, and
      // `resolving` would stack a second spinner under the error banner.
      this.patch({
        error: `購読フィルタの解決に失敗しました: ${message(error)}`,
        follows: this.state.follows && { status: 'missing', count: 0, truncated: 0 },
      });
      return;
    }
    if (this.stopped) {
      return;
    }
    // The source found nothing safe to ask for and has said why through
    // `setFollows`. Widening to a fallback filter here is what it must not do.
    if (filters.length === 0) {
      return;
    }
    this.subscribe(filters);
  }

  /**
   * Boot for a single post: its own REQ first, then the watches around it.
   *
   * The order is the point. The post is one primary-key lookup; the watches
   * read every row carrying its id in an `e` tag. The relay serves both on the
   * page's thread, first REQ first, and the reader waits on the post.
   */
  async startPost(target: PostTarget, wants: PostWatches = {}): Promise<void> {
    this.postGeneration += 1;
    const generation = this.postGeneration;
    await this.start([target.filter]);
    // A {@link showPost} landing while the relay booted has already closed its
    // watches, so opening these would leave them running with nothing to end.
    if (generation !== this.postGeneration) {
      return;
    }
    // No post for these to be about — and the watches spend a key on whatever
    // they are asked for, so queueing here would make the omission permanent.
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
   * Close the subscription, keeping the relay and connection; {@link applyFilter}
   * starts again. For benchmarking: a live subscription reads through to
   * upstream and would contaminate a cold pass.
   */
  suspend(): void {
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.suspended = true;
    // A resolving source holds a subscription of its own. Its state goes too,
    // or `resolving` strands the widget on a spinner nothing will clear.
    this.filterSourceAbort.abort();
    this.patch({ follows: undefined });
    this.closeLookups();
    this.validation.clearTimers();
  }

  /** Safe to call twice, and while {@link start} is in flight. */
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

  /** A live lookup would refill the cache a `suspend()` measures cold. */
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
      // Re-armed so a resumed controller can run a filter source again.
      this.filterSourceAbort = new AbortController();
    }
    this.profiles.reset();
    this.embeds.reset();
    // Reactions and replies survive: the caller named the post, so a new filter
    // says nothing about whether they are still wanted. {@link showPost} knows.
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
        // Without a host nothing can tell cache from upstream; leave it unset
        // so no badge is rendered rather than guessing.
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

  requestProfile(pubkey: string): void {
    this.profiles.request(pubkey);
  }

  requestEmbed(target: EmbedTarget): void {
    this.embeds.request(target);
  }

  requestReactions(target: PostTarget, limit?: number): void {
    this.reactions.request(target, limit);
  }

  requestReplies(target: PostTarget, options: ReplyRequestOptions = {}): void {
    this.replies.request(target, options);
  }

  /**
   * Point the widget at a different post, keeping the relay and connection.
   *
   * Not {@link applyFilter}: the reactions and thread belong to the post, so
   * leaving them open leaks `MAX_REPLY_DEPTH + 1` subscriptions per hop. Their
   * events go too; the cache answers the way back from IndexedDB anyway.
   */
  showPost(target: PostTarget, wants: PostWatches = {}): void {
    // Supersedes a {@link startPost} still waiting on the relay.
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
   * The presence of a key is the request and its value only the settings, so an
   * absent limit must not read as an absent request.
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
   * `dropped` is acted on rather than displayed: the subscription asks for a
   * population the cache can no longer vouch for, and the follow list is never
   * re-read, so it would run until unmount.
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
   * Every id the widget rendered a card for. Quotes and replies count: they are
   * faded until vouched for, so an empty timeline can still have one to ask about.
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
   * rx-nostr holds a REQ issued while reconnecting and sends it on, so a filter
   * change must go through rather than leave an error the reader is stuck on.
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
