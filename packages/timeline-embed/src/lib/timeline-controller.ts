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
import { ProfileStore } from './profile-store.ts';
import type { Profile } from './profile.ts';
import { type ConnectionStatus, RelayConnection } from './relay-connection.ts';
import { type RelayHost, type RelayHostConfig, acquireRelayHost } from './relay-host.ts';
import { type RequestDurations, RequestTimer } from './request-timer.ts';
import { insertEvent } from './timeline-utils.ts';
import { type ValidationStatus, fetchValidationStatuses, hasPending } from './validation-status.ts';

/** Batches the validation lookups triggered by a burst of incoming events. */
const VALIDATION_FETCH_DEBOUNCE_MS = 200;
/** Lazy validation runs in the background, so re-poll while anything is pending. */
const VALIDATION_POLL_INTERVAL_MS = 5000;

export interface TimelineState {
  status: ConnectionStatus;
  events: NostrEvent[];
  origins: Map<string, EventOrigin>;
  validationStatuses: Map<string, ValidationStatus>;
  /** Author profiles (kind 0) fetched so far, keyed by pubkey. */
  profiles: Map<string, Profile>;
  eose: boolean;
  error?: string;
}

export interface TimelineControllerOptions {
  /** Relay settings. The first widget on a page wins — see `relay-host.ts`. */
  host?: RelayHostConfig;
  /** Cap on events held in the timeline. */
  maxEvents?: number;
  /** Called with a fresh snapshot whenever anything changes. */
  onChange: (state: TimelineState) => void;
}

export class TimelineController {
  private connection: RelayConnection;
  private relayHost?: RelayHost;
  private profileStore?: ProfileStore;
  private readonly timer = new RequestTimer();
  private readonly options: TimelineControllerOptions;
  private state: TimelineState = {
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    eose: false,
  };
  private currentSubId: string | null = null;
  private subSeq = 0;
  private validationFetchTimer?: ReturnType<typeof setTimeout>;
  private validationPollTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** Settles on stop(), so a pending connect() cannot leave start() hanging. */
  private readonly stopSignal: Promise<void>;
  private signalStopped!: () => void;

  constructor(options: TimelineControllerOptions) {
    this.options = options;
    this.stopSignal = new Promise((resolve) => {
      this.signalStopped = resolve;
    });
    this.connection = new RelayConnection({
      onStatusChange: (status) => this.patch({ status }),
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
   * @param filter NIP-01 filter for the timeline
   */
  async start(filter: Filter): Promise<void> {
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
    this.subscribe(filter);
  }

  /** Replace the subscription, clearing the timeline and restarting timing. */
  applyFilter(filter: Filter): void {
    this.subscribe(filter);
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
    // The profile subscription reads through to upstream just like the
    // timeline's does, so leaving it open would keep refilling the very cache
    // the caller is about to measure cold.
    this.profileStore?.close();
    this.profileStore = undefined;
    this.clearTimers();
  }

  /**
   * Close the subscription and release this widget's claim on the relay. Safe
   * to call more than once, and safe to call while {@link start} is in flight.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStopped();
    this.clearTimers();
    this.profileStore?.close();
    this.profileStore = undefined;
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.connection.disconnect();
    const host = this.relayHost;
    this.relayHost = undefined;
    await host?.release();
  }

  private subscribe(filter: Filter): void {
    if (this.currentSubId) {
      this.connection.unsubscribe(this.currentSubId);
      this.currentSubId = null;
    }
    this.clearTimers();
    // A store is single-use: close() is terminal, so resuming after suspend()
    // needs a fresh one. Profiles already parsed stay in state, so authors do
    // not flicker back to their pubkeys while the new store refills.
    this.profileStore?.close();
    this.profileStore = this.createProfileStore();
    // Timings are per subscription id and never revisited once replaced.
    this.timer.clear();
    this.patch({
      events: [],
      origins: new Map(),
      validationStatuses: new Map(),
      eose: false,
      error: undefined,
    });

    if (!this.connection.isConnected) {
      // Say so rather than leaving the UI on "読み込み中…" forever.
      this.patch({ error: 'リレーに接続していないため購読できません' });
      return;
    }

    this.subSeq += 1;
    const subId = `timeline-${this.subSeq}`;
    this.currentSubId = subId;
    this.timer.start(subId);

    this.connection.subscribe(subId, [filter], {
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
        this.profileStore?.request([event.pubkey]);
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
   * Build the kind 0 subscription that feeds author names and avatars.
   *
   * Profile deliveries are classified through `CacheMetrics` as well, so the
   * cache/upstream counters describe the same population of events: the
   * instrumented upstream pool already counts kind 0 arrivals as upstream
   * events, and leaving them unclassified would make the delivered/cache-hit
   * numbers cover a smaller set than the upstream one.
   *
   */
  private createProfileStore(): ProfileStore {
    return new ProfileStore({
      connection: this.connection,
      onEvent: (event) => {
        this.relayHost?.metrics.classifyDelivered(event.id);
      },
      onChange: (profiles) => {
        this.patch({ profiles: new Map([...this.state.profiles, ...profiles]) });
      },
    });
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
    if (!host || this.state.events.length === 0) {
      return;
    }
    let statuses: Map<string, ValidationStatus>;
    try {
      statuses = await fetchValidationStatuses(
        host.relay,
        this.state.events.map((event) => event.id)
      );
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
