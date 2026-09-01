/**
 * 上流リレー接続のプール。接続・再接続・REQ 再送は rx-nostr が持つ。
 *
 * ここに残るのは rx-nostr で代替できない EOSE の集約だけ。rx-nostr の集約は
 * backward strategy の機能で EOSE 時に購読を閉じてしまうが、上流購読は EOSE 後も
 * 開いたままにする必要がある（doc/cache-relay/upstream.md 第2.1節）。
 */

import { DEFAULT_MAX_CONCURRENT_RELAYS, logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { ConnectionStatePacket, EventSigner, LazyFilter, RxNostr } from 'rx-nostr';
import { createRxForwardReq, createRxNostr } from 'rx-nostr';
import type { UpstreamPool, UpstreamPoolOptions } from './upstream-types.js';

const DEFAULT_RECONNECT_BASE_DELAY = 1000;
const DEFAULT_RECONNECT_MAX_DELAY = 60000;

/**
 * Suffix rx-nostr appends to build a forward-strategy REQ's wire subscription
 * id: it composes `${rxReqId}:${childId}`, with the child id pinned to 0 under
 * that strategy. Passing the coordinator's `upstreamSubId` as the `rxReqId`
 * therefore makes the wire id reversible, which is what lets EOSE — delivered
 * on the shared message stream, not through `use()` — find its subscription.
 */
const WIRE_SUB_ID_SUFFIX = ':0';

/** The `upstreamSubId` behind a wire id, or undefined if it is not one of ours. */
function fromWireSubId(wireSubId: string): string | undefined {
  return wireSubId.endsWith(WIRE_SUB_ID_SUFFIX)
    ? wireSubId.slice(0, -WIRE_SUB_ID_SUFFIX.length)
    : undefined;
}

/**
 * The pool forwards events a client already signed, so "signing" is the
 * identity function. Declaring it keeps rx-nostr's default NIP-07 signer — and
 * its reach for `window.nostr` — out of a relay.
 */
const PASSTHROUGH_SIGNER: EventSigner = {
  signEvent: async (event) => event as never,
  getPublicKey: async () => {
    throw new Error('UpstreamRelayPool does not sign; publish() takes a signed event');
  },
};

export class UpstreamRelayPool implements UpstreamPool {
  private readonly urls: string[];
  private rxNostr?: RxNostr;
  /** Set by stop(), so a late publish or REQ cannot resurrect the connections. */
  private stopped = false;
  /** Live subscriptions by upstream sub id; unsubscribing makes rx-nostr send CLOSE. */
  private readonly subscriptions = new Map<string, { unsubscribe(): void }>();
  /** Relays still owing an EOSE per subscription (empty set → already fired). */
  private readonly pendingEose = new Map<string, Set<string>>();
  /** Pending re-arm per relay rx-nostr has given up on, keyed by relay url. */
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private streams?: { unsubscribe(): void };
  private eventCallback?: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void;
  private eoseCallback?: (upstreamSubId: string) => void;

  constructor(
    urls: string[],
    private readonly options: UpstreamPoolOptions = {}
  ) {
    // rx-nostr de-duplicates by normalized URL itself, but the cap has to apply
    // to what the caller asked for, before any of them is handed over.
    const maxRelays = options.maxRelays ?? DEFAULT_MAX_CONCURRENT_RELAYS;
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length > maxRelays) {
      logger.warn(`Upstream: ${uniqueUrls.length} relays configured, using the first ${maxRelays}`);
    }
    this.urls = uniqueUrls.slice(0, maxRelays);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();

    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    this.pendingEose.clear();

    // Detach before disposing: dispose() drives every relay to `terminated`,
    // which would otherwise come back through handleConnectionState.
    this.streams?.unsubscribe();
    this.streams = undefined;
    this.rxNostr?.dispose();
    this.rxNostr = undefined;
  }

  publish(event: NostrEvent): void {
    // `completeOn: 'sent'` is done the moment the EVENT has gone out. The
    // default would hold the send open until every relay answered OK or the 30s
    // timeout expired, once per event — and write-through never waits for the
    // upstream's verdict anyway.
    this.connect()
      ?.send(event as never, { completeOn: 'sent' })
      .subscribe({ error: () => {} });
  }

  openSubscription(upstreamSubId: string, filters: Filter[]): void {
    const rxNostr = this.connect();
    if (!rxNostr) {
      return;
    }
    // Reusing an id replaces the subscription rather than shadowing it.
    this.closeSubscription(upstreamSubId);

    // Snapshot the relays connected right now; only those owe an EOSE. An empty
    // filter list is dropped by rx-nostr, so no REQ goes out and nobody would
    // ever answer — nothing owes an EOSE in that case either.
    const connectedUrls = new Set(filters.length > 0 ? this.connectedUrls() : []);
    this.pendingEose.set(upstreamSubId, connectedUrls);

    if (filters.length > 0) {
      const req = createRxForwardReq(upstreamSubId);
      // Subscribe before emitting: the request stream is hot, so a filter
      // emitted first would be dropped and no REQ would ever be sent.
      const events = rxNostr.use(req).subscribe(({ event, from }) => {
        this.eventCallback?.(upstreamSubId, event as NostrEvent, from);
      });
      this.subscriptions.set(upstreamSubId, events);
      req.emit(filters as LazyFilter[]);
    }

    // Nobody will ever answer → fire EOSE on the next tick. The guard compares
    // the Set by identity, not by size: reusing the id in the same tick leaves
    // two microtasks queued, and a size check would let the first one fire the
    // second subscription's EOSE and leave the second with none.
    if (connectedUrls.size === 0) {
      queueMicrotask(() => {
        if (this.pendingEose.get(upstreamSubId) === connectedUrls) {
          this.fireEose(upstreamSubId);
        }
      });
    }
  }

  closeSubscription(upstreamSubId: string): void {
    this.pendingEose.delete(upstreamSubId);
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

  /**
   * The rx-nostr client, created and connected on first use. Creation is
   * deferred rather than done in the constructor because of `webSocketFactory`:
   * in the browser the emulator replaces the global WebSocket, and upstream
   * connections must keep using the pre-patch one or an intercepted URL loops
   * back into ourselves. Deferring also means a REQ that lands in the window
   * between the relay starting its transport and starting the pool still gets
   * an upstream subscription, instead of silently going without one.
   */
  private connect(): RxNostr | undefined {
    // `stopped` first: a stop() that threw part-way through may have left the
    // client behind, and nothing may reconnect through it after that.
    if (this.stopped) {
      return undefined;
    }
    if (this.rxNostr) {
      return this.rxNostr;
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
      // One HTTP request per upstream relay, for limits this pool does not use.
      skipFetchNip11: true,
      // Connect now: the default ("lazy") would wait for the first REQ, and the
      // EOSE aggregate only counts relays that are already up.
      connectionStrategy: 'aggressive',
      signer: PASSTHROUGH_SIGNER,
      retry: {
        strategy: 'exponential',
        maxCount: 5,
        initialDelay: this.options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY,
      },
      websocketCtor: (this.options.webSocketFactory ?? (() => globalThis.WebSocket))(),
    });
    this.rxNostr = rxNostr;

    const streams = rxNostr.createConnectionStateObservable().subscribe((packet) => {
      this.handleConnectionState(packet);
    });
    // EOSE does not come through use() — that carries events only.
    streams.add(
      rxNostr.createAllMessageObservable().subscribe((packet) => {
        if (packet.type === 'EOSE') {
          this.handleRelayEose(packet.from, packet.subId);
        }
      })
    );
    this.streams = streams;

    rxNostr.setDefaultRelays(this.urls);
    return rxNostr;
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
   * timeout. Drop it from every pending set and fire the aggregates that are
   * now complete.
   *
   * `error` additionally means rx-nostr has spent its retries and will not come
   * back on its own. A browser tab can be reloaded, but a relay process cannot,
   * so losing an upstream permanently to one outage is not acceptable here:
   * re-arm it after a cooldown, which keeps retrying indefinitely (as the
   * hand-rolled connection did) without a tight loop. `rejected` (the relay
   * closed with code 4000, "do not come back") is deliberately left alone.
   */
  private handleConnectionState({ from, state }: ConnectionStatePacket): void {
    if (state === 'connected') {
      return;
    }
    const toFire: string[] = [];
    for (const [upstreamSubId, pending] of this.pendingEose) {
      if (pending.delete(from) && pending.size === 0) {
        toFire.push(upstreamSubId);
      }
    }
    for (const upstreamSubId of toFire) {
      this.fireEose(upstreamSubId);
    }

    if (state === 'error' && !this.recoveryTimers.has(from)) {
      const delay = this.options.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY;
      logger.debug(`Upstream ${from}: retries exhausted, reconnecting in ${delay}ms`);
      this.recoveryTimers.set(
        from,
        setTimeout(() => {
          this.recoveryTimers.delete(from);
          try {
            this.rxNostr?.reconnect(from);
          } catch (error) {
            // reconnect() throws for a relay it does not know; an uncaught
            // throw in a timer would take a relay process down with it.
            logger.debug(`Upstream ${from}: reconnect failed:`, error);
          }
        }, delay)
      );
    }
  }

  /** Record a relay's EOSE and, once all pending relays have answered, fire once. */
  private handleRelayEose(relayUrl: string, wireSubId: string): void {
    const upstreamSubId = fromWireSubId(wireSubId);
    // Unknown id: not ours, already fired, or the subscription was closed.
    const pending = upstreamSubId ? this.pendingEose.get(upstreamSubId) : undefined;
    if (!upstreamSubId || !pending) {
      return;
    }
    pending.delete(relayUrl);
    if (pending.size === 0) {
      this.fireEose(upstreamSubId);
    }
  }

  /** Emit the aggregated EOSE exactly once, then forget the pending set. */
  private fireEose(upstreamSubId: string): void {
    if (this.pendingEose.delete(upstreamSubId)) {
      this.eoseCallback?.(upstreamSubId);
    }
  }
}
