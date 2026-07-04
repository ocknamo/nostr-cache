/**
 * Orchestrates read-through / write-through between the local relay and the
 * upstream pool.
 *
 * Responsibilities:
 * - Map each client subscription `(clientId, subscriptionId)` to a short
 *   upstream subscription id (kept well under NIP-01's 64-char limit) and back.
 * - De-duplicate events per subscription (against what the client already got
 *   from local storage and from other upstream relays), with a bounded memory
 *   footprint.
 * - Backfill upstream events into local storage via the injected `ingest`
 *   (which reuses the relay's normal event handling: validation mode,
 *   replaceable/ephemeral rules, lazy validation, storage limits).
 * - Deliver deduped, backfilled events to the owning client.
 * - Hold back the client's EOSE until the upstream pool's aggregated EOSE (or a
 *   timeout), so one-shot clients see upstream results before "end of stored".
 * - Clean up upstream subscriptions on CLOSE and on client disconnect.
 * - Forward published events upstream (write-through, fire-and-forget).
 */

import { DEFAULT_SUBSCRIPTION_TIMEOUT, logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { UpstreamPool } from './upstream-types.js';

/** Result of backfilling one upstream event through the relay's ingest path. */
export interface IngestResult {
  success: boolean;
  stored: boolean;
}

export interface UpstreamCoordinatorDeps {
  pool: UpstreamPool;
  /**
   * Backfill one upstream event: validate (per the relay's mode), store
   * (honouring replaceable/ephemeral rules), and enforce limits — but do NOT
   * send OK or broadcast. Returns whether it was accepted / stored.
   */
  ingest: (event: NostrEvent) => Promise<IngestResult>;
  /** Deliver an accepted event to the owning client subscription. */
  deliver: (clientId: string, subscriptionId: string, event: NostrEvent) => void;
  /** Send EOSE to the owning client subscription. */
  sendEose: (clientId: string, subscriptionId: string) => void;
}

export interface UpstreamCoordinatorOptions {
  /** Max time to hold the client's EOSE waiting for upstream. Default 3000ms. */
  eoseTimeout?: number;
  /** Max deduped event ids remembered per subscription. Default 10000. */
  maxSentIdsPerSub?: number;
}

interface SubState {
  clientId: string;
  subscriptionId: string;
  sentIds: Set<string>;
  eoseSent: boolean;
  eoseTimer?: ReturnType<typeof setTimeout>;
  /** Serializes ingest of this subscription's upstream events. */
  ingestChain: Promise<void>;
  /** Set once the subscription is closed so in-flight ingests stop delivering. */
  closed: boolean;
}

/** Compose the client/sub map key. Matches SubscriptionManager's key shape. */
function clientSubKey(clientId: string, subscriptionId: string): string {
  return `${clientId}:${subscriptionId}`;
}

export class UpstreamCoordinator {
  private readonly pool: UpstreamPool;
  private readonly eoseTimeout: number;
  private readonly maxSentIdsPerSub: number;
  private readonly subs = new Map<string, SubState>();
  private readonly byClientSub = new Map<string, string>();
  private upstreamSubSequence = 0;

  constructor(
    private readonly deps: UpstreamCoordinatorDeps,
    options: UpstreamCoordinatorOptions = {}
  ) {
    this.pool = deps.pool;
    this.eoseTimeout = options.eoseTimeout ?? DEFAULT_SUBSCRIPTION_TIMEOUT;
    this.maxSentIdsPerSub = options.maxSentIdsPerSub ?? 10_000;
    // Wire pool callbacks eagerly (not in start()) so a subscription opened
    // before start() — e.g. an in-process subscribe() before connect() — still
    // receives upstream events and the aggregated EOSE.
    this.pool.onEvent((upstreamSubId, event) => this.handleUpstreamEvent(upstreamSubId, event));
    this.pool.onEose((upstreamSubId) => this.handleUpstreamEose(upstreamSubId));
  }

  /** Start connecting to the upstream relays. */
  async start(): Promise<void> {
    await this.pool.start();
  }

  /** Clear all pending EOSE timers and stop the pool. */
  async stop(): Promise<void> {
    for (const state of this.subs.values()) {
      // Mark closed so any in-flight ingest queued on a subscription's chain
      // stops before it delivers (the chain re-checks `state.closed`).
      state.closed = true;
      this.clearEoseTimer(state);
    }
    this.subs.clear();
    this.byClientSub.clear();
    await this.pool.stop();
  }

  /**
   * Open an upstream subscription for a client REQ. `sentIds` are the ids the
   * client already received from local storage, pre-seeded into the dedup set
   * so upstream never re-delivers them. The client's EOSE is sent later (by the
   * aggregated upstream EOSE or the timeout).
   */
  openForSubscription(
    clientId: string,
    subscriptionId: string,
    filters: Filter[],
    sentIds: Iterable<string>
  ): void {
    // A REQ reusing an existing subscription id replaces the old one.
    this.closeForSubscription(clientId, subscriptionId);

    const upstreamSubId = this.nextUpstreamSubId();
    const seededIds = new Set<string>();
    for (const id of sentIds) {
      seededIds.add(id);
    }
    const state: SubState = {
      clientId,
      subscriptionId,
      sentIds: seededIds,
      eoseSent: false,
      ingestChain: Promise.resolve(),
      closed: false,
    };
    state.eoseTimer = setTimeout(() => this.flushEose(upstreamSubId), this.eoseTimeout);

    this.subs.set(upstreamSubId, state);
    this.byClientSub.set(clientSubKey(clientId, subscriptionId), upstreamSubId);
    this.pool.openSubscription(upstreamSubId, filters);
  }

  /** Close the upstream subscription for a client CLOSE (or REQ overwrite). */
  closeForSubscription(clientId: string, subscriptionId: string): void {
    const key = clientSubKey(clientId, subscriptionId);
    const upstreamSubId = this.byClientSub.get(key);
    if (!upstreamSubId) {
      return;
    }
    this.byClientSub.delete(key);
    const state = this.subs.get(upstreamSubId);
    if (state) {
      state.closed = true;
      this.clearEoseTimer(state);
      this.subs.delete(upstreamSubId);
    }
    this.pool.closeSubscription(upstreamSubId);
  }

  /** Close every upstream subscription owned by a disconnected client. */
  closeAllForClient(clientId: string): void {
    const prefix = `${clientId}:`;
    for (const key of [...this.byClientSub.keys()]) {
      if (key.startsWith(prefix)) {
        // subscriptionId is the remainder after the first ':'.
        const subscriptionId = key.slice(prefix.length);
        this.closeForSubscription(clientId, subscriptionId);
      }
    }
  }

  /** Forward a published event upstream (write-through, fire-and-forget). */
  publish(event: NostrEvent): void {
    this.pool.publish(event);
  }

  /**
   * Record that an event was already delivered to a client subscription through
   * another path (a local broadcast in `MessageHandler`, or the in-process
   * `emit`). This seeds the subscription's dedup set so that the upstream echo
   * of the same event — inevitable once write-through forwards it upstream — is
   * dropped instead of re-delivered. No-op if the subscription has no upstream
   * counterpart.
   *
   * @param clientId Owning client
   * @param subscriptionId Owning subscription
   * @param eventId Id of the event already sent to that subscription
   */
  markDelivered(clientId: string, subscriptionId: string, eventId: string): void {
    const upstreamSubId = this.byClientSub.get(clientSubKey(clientId, subscriptionId));
    if (!upstreamSubId) {
      return;
    }
    const state = this.subs.get(upstreamSubId);
    if (state) {
      this.addSentId(state, eventId);
    }
  }

  /**
   * Dedup, backfill and deliver an upstream event. Ingest is serialized per
   * subscription so replaceable events cannot race each other.
   */
  private handleUpstreamEvent(upstreamSubId: string, event: NostrEvent): void {
    const state = this.subs.get(upstreamSubId);
    if (!state) {
      // Subscription already closed; drop.
      return;
    }
    if (state.sentIds.has(event.id)) {
      return;
    }
    state.ingestChain = state.ingestChain.then(async () => {
      // Re-check: the subscription may have closed while queued, or another
      // relay may have delivered the same id first.
      if (state.closed || state.sentIds.has(event.id)) {
        return;
      }
      let result: IngestResult;
      try {
        result = await this.deps.ingest(event);
      } catch (error) {
        logger.debug('Upstream event ingest failed:', error);
        return;
      }
      if (!result.success || state.closed) {
        return;
      }
      this.addSentId(state, event.id);
      // Delivery goes out over the transport; never let a send failure turn the
      // ingest chain into an unhandled rejection.
      try {
        this.deps.deliver(state.clientId, state.subscriptionId, event);
      } catch (error) {
        logger.debug('Upstream event delivery failed:', error);
      }
    });
  }

  /** Aggregated upstream EOSE arrived: release the client's EOSE if pending. */
  private handleUpstreamEose(upstreamSubId: string): void {
    this.flushEose(upstreamSubId);
  }

  /** Send the client EOSE exactly once (from aggregated EOSE or timeout). */
  private flushEose(upstreamSubId: string): void {
    const state = this.subs.get(upstreamSubId);
    if (!state || state.eoseSent) {
      return;
    }
    state.eoseSent = true;
    this.clearEoseTimer(state);
    this.deps.sendEose(state.clientId, state.subscriptionId);
  }

  /** Add an id to the dedup set, evicting the oldest when the cap is exceeded. */
  private addSentId(state: SubState, id: string): void {
    state.sentIds.add(id);
    if (state.sentIds.size > this.maxSentIdsPerSub) {
      // Sets iterate in insertion order; drop the oldest entry.
      const oldest = state.sentIds.values().next().value;
      if (oldest !== undefined) {
        state.sentIds.delete(oldest);
      }
    }
  }

  private clearEoseTimer(state: SubState): void {
    if (state.eoseTimer) {
      clearTimeout(state.eoseTimer);
      state.eoseTimer = undefined;
    }
  }

  private nextUpstreamSubId(): string {
    this.upstreamSubSequence += 1;
    return `up${this.upstreamSubSequence}`;
  }
}
