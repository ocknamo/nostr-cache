/**
 * A pool of upstream relay connections, backed by rx-nostr.
 *
 * Connection lifecycle — opening sockets, reconnecting with backoff, re-issuing
 * the REQs that were open when one dropped, normalizing and de-duplicating relay
 * URLs — is rx-nostr's job, not this class's. What is left here is the one thing
 * rx-nostr cannot do for us: aggregating per-relay EOSE into a single
 * per-subscription EOSE. It fires once every relay that was connected at
 * subscription time has answered (or immediately when no relay was connected).
 * Relays that connect later do not participate in the aggregate, so a slow or
 * down relay never stalls the client's EOSE forever.
 *
 * rx-nostr's own EOSE aggregation is a backward-strategy feature and closes the
 * subscription when it fires. Upstream subscriptions have to stay open past EOSE
 * so live events keep flowing (`doc/cache-relay/upstream.md` §3), which forces
 * the forward strategy — where `use()` carries EVENTs only and EOSE arrives on
 * the shared message stream.
 */

import { DEFAULT_MAX_CONCURRENT_RELAYS, logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { ConnectionStatePacket, EventSigner, LazyFilter, RxNostr } from 'rx-nostr';
import { createRxForwardReq, createRxNostr } from 'rx-nostr';
import type { UpstreamPool, UpstreamPoolOptions } from './upstream-types.js';

const DEFAULT_RECONNECT_BASE_DELAY = 1000;
const DEFAULT_RECONNECT_MAX_DELAY = 60000;

/**
 * Consecutive auto-retries rx-nostr makes before parking a relay in `error`.
 * The ladder is exponential from `reconnectBaseDelay`, so five attempts cover
 * roughly half a minute — long enough for an ordinary blip, short enough that
 * {@link UpstreamRelayPool.scheduleRecovery} takes over quickly when it is not.
 */
const RETRY_MAX_COUNT = 5;

/**
 * Suffix rx-nostr appends to build the wire subscription id of a
 * forward-strategy REQ. It composes the id as `${rxReqId}:${childId}`, and the
 * child id is pinned to 0 under the forward strategy (a forward REQ overwrites
 * its predecessor rather than opening a second one). Passing the coordinator's
 * `upstreamSubId` as the `rxReqId` therefore makes the wire id derivable, which
 * is what lets EOSE — which arrives on the shared message stream, not through
 * `use()` — be routed back to the right subscription.
 */
const WIRE_SUB_ID_SUFFIX = ':0';

/** The `upstreamSubId` behind a wire id, or undefined if it is not one of ours. */
function fromWireSubId(wireSubId: string): string | undefined {
  return wireSubId.endsWith(WIRE_SUB_ID_SUFFIX)
    ? wireSubId.slice(0, -WIRE_SUB_ID_SUFFIX.length)
    : undefined;
}

/**
 * The pool never signs: {@link UpstreamRelayPool.publish} forwards events that
 * a client already signed, so "signing" is the identity function. Declaring it
 * keeps rx-nostr's default NIP-07 signer — and its reach for `window.nostr` —
 * out of a relay that has no business prompting for a browser extension.
 */
const PASSTHROUGH_SIGNER: EventSigner = {
  signEvent: async (event) => event as never,
  getPublicKey: async () => {
    throw new Error('UpstreamRelayPool does not sign; publish() takes a signed event');
  },
};

export class UpstreamRelayPool implements UpstreamPool {
  private readonly urls: string[];
  private readonly options: UpstreamPoolOptions;
  private rxNostr?: RxNostr;
  /** Live subscriptions by upstream sub id; unsubscribing makes rx-nostr send CLOSE. */
  private readonly subscriptions = new Map<string, { unsubscribe(): void }>();
  /** Relays still owing an EOSE per subscription (empty set → already fired). */
  private readonly pendingEose = new Map<string, Set<string>>();
  /**
   * REQs that arrived before {@link start}, replayed once rx-nostr exists. The
   * relay opens its transport before the upstream, so a client can get a REQ in
   * during that window; dropping it would cost that subscription its upstream
   * for as long as it lives.
   */
  private readonly bufferedSubscriptions = new Map<string, Filter[]>();
  /** Pending re-arm per relay rx-nostr has given up on, keyed by relay url. */
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private teardown: (() => void)[] = [];
  private eventCallback?: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void;
  private eoseCallback?: (upstreamSubId: string) => void;

  constructor(urls: string[], options: UpstreamPoolOptions = {}) {
    this.options = options;

    // rx-nostr de-duplicates by normalized URL on its own, but the cap has to be
    // applied to what the caller asked for, before any of them is handed over.
    const maxRelays = options.maxRelays ?? DEFAULT_MAX_CONCURRENT_RELAYS;
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length > maxRelays) {
      logger.warn(`Upstream: ${uniqueUrls.length} relays configured, using the first ${maxRelays}`);
    }
    this.urls = uniqueUrls.slice(0, maxRelays);
  }

  async start(): Promise<void> {
    if (this.rxNostr) {
      return;
    }

    const rxNostr = createRxNostr({
      // Upstream events are verified by MessageHandler.ingestUpstreamEvent,
      // which honours `validateEventsType`. Verifying here as well would double
      // the work — and would verify even under `validateEventsType: 'NONE'`,
      // quietly breaking that option.
      skipVerify: true,
      // NIP-40 is not implemented by the relay itself, so leaving this on would
      // drop expired events on the upstream path only.
      skipExpirationCheck: true,
      // One extra HTTP request per upstream relay, for limits this pool does not
      // use. Enabling it is a separate decision.
      skipFetchNip11: true,
      // start() means "start connecting"; the default ("lazy") would wait for
      // the first REQ, and the EOSE aggregate counts relays that are already up.
      connectionStrategy: 'aggressive',
      signer: PASSTHROUGH_SIGNER,
      retry: {
        strategy: 'exponential',
        maxCount: RETRY_MAX_COUNT,
        initialDelay: this.options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY,
      },
      // Resolve the constructor once, here: in the browser the emulator replaces
      // the global WebSocket, and upstream connections must keep using the
      // pre-patch one or an intercepted URL loops back into ourselves.
      websocketCtor: (this.options.webSocketFactory ?? (() => globalThis.WebSocket))(),
    });
    this.rxNostr = rxNostr;

    const states = rxNostr.createConnectionStateObservable().subscribe((packet) => {
      this.handleConnectionState(packet);
    });
    // EOSE does not come through use() — that carries events only — so it is
    // picked off the shared message stream.
    const messages = rxNostr.createAllMessageObservable().subscribe((packet) => {
      if (packet.type === 'EOSE') {
        this.handleRelayEose(packet.from, packet.subId);
      }
    });
    this.teardown = [() => states.unsubscribe(), () => messages.unsubscribe()];

    rxNostr.setDefaultRelays(this.urls);

    const buffered = [...this.bufferedSubscriptions];
    this.bufferedSubscriptions.clear();
    for (const [upstreamSubId, filters] of buffered) {
      this.openSubscription(upstreamSubId, filters);
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();

    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    this.pendingEose.clear();
    this.bufferedSubscriptions.clear();

    // Detach before disposing: dispose() drives every relay to `terminated`,
    // which would otherwise come back through handleConnectionState.
    const teardown = this.teardown;
    this.teardown = [];
    for (const off of teardown) {
      off();
    }

    this.rxNostr?.dispose();
    this.rxNostr = undefined;
  }

  publish(event: NostrEvent): void {
    // `completeOn: 'sent'` is done the moment the EVENT has gone out. The
    // default would hold the send open until every relay answered OK or the
    // 30s timeout expired, once per published event — and the upstream OK is
    // not waited on anyway (write-through is fire-and-forget).
    this.rxNostr?.send(event as never, { completeOn: 'sent' }).subscribe({ error: () => {} });
  }

  openSubscription(upstreamSubId: string, filters: Filter[]): void {
    const rxNostr = this.rxNostr;
    if (!rxNostr) {
      this.bufferedSubscriptions.set(upstreamSubId, filters);
      return;
    }
    // Reusing an id replaces the subscription rather than shadowing it.
    this.closeSubscription(upstreamSubId);

    // Snapshot the relays connected right now; only those owe an EOSE.
    const connectedUrls = new Set(this.connectedUrls());
    this.pendingEose.set(upstreamSubId, connectedUrls);

    const req = createRxForwardReq(upstreamSubId);
    // Subscribe before emitting: the request stream is hot, so a filter emitted
    // first would be dropped and no REQ would ever be sent.
    const events = rxNostr.use(req).subscribe(({ event, from }) => {
      this.eventCallback?.(upstreamSubId, event as NostrEvent, from);
    });
    this.subscriptions.set(upstreamSubId, events);
    req.emit(filters as LazyFilter[]);

    // No relay connected → nothing will ever answer; fire EOSE on the next tick.
    if (connectedUrls.size === 0) {
      queueMicrotask(() => {
        // Guard against a CLOSE that arrived before the microtask ran.
        if (this.pendingEose.get(upstreamSubId)?.size === 0) {
          this.fireEose(upstreamSubId);
        }
      });
    }
  }

  closeSubscription(upstreamSubId: string): void {
    this.pendingEose.delete(upstreamSubId);
    this.bufferedSubscriptions.delete(upstreamSubId);
    // Unsubscribing is what sends CLOSE.
    this.subscriptions.get(upstreamSubId)?.unsubscribe();
    this.subscriptions.delete(upstreamSubId);
  }

  onEvent(callback: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void): void {
    this.eventCallback = callback;
  }

  onEose(callback: (upstreamSubId: string) => void): void {
    this.eoseCallback = callback;
  }

  getConnectedCount(): number {
    return this.connectedUrls().length;
  }

  /** Relay urls whose socket is established right now (normalized by rx-nostr). */
  private connectedUrls(): string[] {
    return Object.entries(this.rxNostr?.getAllRelayStatus() ?? {})
      .filter(([, status]) => status.connection === 'connected')
      .map(([url]) => url);
  }

  /**
   * A relay changed state; two things follow.
   *
   * Anything other than `connected` means it can no longer answer EOSE for the
   * subscriptions it was counted in, so stop waiting on it — otherwise a relay
   * that goes away mid-REQ stalls the client's EOSE until the coordinator
   * timeout.
   *
   * `error` additionally means rx-nostr has spent its retries and will not come
   * back on its own. A browser tab can be reloaded, but a relay process cannot,
   * so losing an upstream permanently to one network outage is not acceptable
   * here: {@link scheduleRecovery} re-arms it. `rejected` (the relay closed with
   * code 4000, "do not come back") is deliberately left alone.
   */
  private handleConnectionState({ from, state }: ConnectionStatePacket): void {
    if (state !== 'connected') {
      this.handleRelayDown(from);
    }
    if (state === 'error') {
      this.scheduleRecovery(from);
    }
  }

  /**
   * Ask rx-nostr to try a relay again after a cooldown, restarting its retry
   * ladder. Repeating for as long as the relay stays down is what keeps the
   * unlimited-retry behaviour the hand-rolled connection had, at one attempt
   * per cooldown instead of a tight loop.
   */
  private scheduleRecovery(relayUrl: string): void {
    if (this.recoveryTimers.has(relayUrl)) {
      return;
    }
    const delay = this.options.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY;
    logger.debug(`Upstream ${relayUrl}: retries exhausted, reconnecting in ${delay}ms`);
    this.recoveryTimers.set(
      relayUrl,
      setTimeout(() => {
        this.recoveryTimers.delete(relayUrl);
        try {
          this.rxNostr?.reconnect(relayUrl);
        } catch (error) {
          logger.debug(`Upstream ${relayUrl}: reconnect failed:`, error);
        }
      }, delay)
    );
  }

  /**
   * A relay went away: drop it from every pending set and fire the aggregated
   * EOSE for subscriptions that are now complete.
   */
  private handleRelayDown(relayUrl: string): void {
    const toFire: string[] = [];
    for (const [upstreamSubId, pending] of this.pendingEose) {
      if (pending.delete(relayUrl) && pending.size === 0) {
        toFire.push(upstreamSubId);
      }
    }
    for (const upstreamSubId of toFire) {
      this.fireEose(upstreamSubId);
    }
  }

  /** Record a relay's EOSE and, once all pending relays have answered, fire once. */
  private handleRelayEose(relayUrl: string, wireSubId: string): void {
    const upstreamSubId = fromWireSubId(wireSubId);
    if (upstreamSubId === undefined) {
      return;
    }
    const pending = this.pendingEose.get(upstreamSubId);
    if (!pending) {
      // Already fired, or the subscription was closed.
      return;
    }
    pending.delete(relayUrl);
    if (pending.size === 0) {
      this.fireEose(upstreamSubId);
    }
  }

  /** Emit the aggregated EOSE exactly once, then forget the pending set. */
  private fireEose(upstreamSubId: string): void {
    if (!this.pendingEose.has(upstreamSubId)) {
      return;
    }
    this.pendingEose.delete(upstreamSubId);
    this.eoseCallback?.(upstreamSubId);
  }
}
