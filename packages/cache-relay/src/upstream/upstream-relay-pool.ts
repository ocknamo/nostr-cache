/**
 * 上流リレー接続のプール。接続・再接続・REQ 再送は rx-nostr が持つ。
 *
 * ここに残るのは rx-nostr で代替できない EOSE の集約（rx-nostr の集約は EOSE 時に購読を
 * 閉じてしまう。doc/cache-relay/upstream.md 第2.1節）と、宛先付きの購読の振り分け。
 */

import { DEFAULT_MAX_CONCURRENT_RELAYS, logger } from '@nostr-cache/shared';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { ConnectionStatePacket, EventSigner, LazyFilter, RxNostr } from 'rx-nostr';
import { createRxForwardReq, createRxNostr } from 'rx-nostr';
import { TemporaryRelays, fromWireSubId, relayKey } from './temporary-relays.js';
import type { UpstreamPool, UpstreamPoolOptions } from './upstream-types.js';

const DEFAULT_RECONNECT_BASE_DELAY = 1000;
const DEFAULT_RECONNECT_MAX_DELAY = 60000;
const DEFAULT_MAX_TEMPORARY_RELAYS = 16;
const DEFAULT_TEMPORARY_RELAY_COOLDOWN = 600_000;

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
  /** 集約 EOSE を出し終えたあと、REQ を送り直して答えを待っているリレー。 */
  private readonly resent = new Map<string, Set<string>>();
  /** Subscriptions on the default relays, which rx-nostr sends to a relay whenever it connects. */
  private readonly defaultSubs = new Set<string>();
  /** Pending re-arm per relay rx-nostr has given up on, keyed by relay url. */
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly temporary: TemporaryRelays;
  private streams?: { unsubscribe(): void };
  private eventCallback?: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void;
  private eoseCallback?: (upstreamSubId: string) => void;
  private resentEoseCallback?: (upstreamSubId: string) => void;
  private resendCallback?: (relayUrl: string) => void;

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
    this.temporary = new TemporaryRelays({
      maxRelays: options.maxTemporaryRelays ?? DEFAULT_MAX_TEMPORARY_RELAYS,
      cooldown: options.temporaryRelayCooldown ?? DEFAULT_TEMPORARY_RELAY_COOLDOWN,
      offlineRetryDelay: options.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY,
      createClient: (relay) => {
        const client = this.createClient('lazy');
        client.setDefaultRelays([relay]);
        return client;
      },
      onEvent: (upstreamSubId, event, relay) => this.eventCallback?.(upstreamSubId, event, relay),
      onEose: (upstreamSubId, relay) => this.settleRelay(upstreamSubId, relay),
      onGaveUp: (relay) => this.dropFromPending(relay),
      onConnected: (relay, upstreamSubIds) => this.markResent(relay, upstreamSubIds),
      isOffline: () => this.defaultsAllFailing(),
    });
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
    this.resent.clear();
    this.defaultSubs.clear();
    this.temporary.stop();

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

  openSubscription(upstreamSubId: string, filters: Filter[], relays?: string[]): void {
    const rxNostr = this.connect();
    if (!rxNostr) {
      return;
    }
    // Reusing an id replaces the subscription rather than shadowing it.
    this.closeSubscription(upstreamSubId);
    if (relays) {
      this.openTargeted(upstreamSubId, filters, relays);
      return;
    }

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
      this.defaultSubs.add(upstreamSubId);
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

  /** 宛先が答えるのを待つ。まだ繋がっていないので、既定の購読のように接続済みで数えない。 */
  private openTargeted(upstreamSubId: string, filters: Filter[], relays: string[]): void {
    const handles: { unsubscribe(): void }[] = [];
    const pending = new Set<string>();
    this.pendingEose.set(upstreamSubId, pending);
    if (filters.length > 0) {
      for (const relay of new Set(relays.map(relayKey))) {
        const handle = this.temporary.subscribe(upstreamSubId, filters, relay);
        if (handle) {
          handles.push(handle);
          pending.add(relay);
        }
      }
    }
    this.subscriptions.set(upstreamSubId, {
      unsubscribe: () => {
        for (const handle of handles) {
          handle.unsubscribe();
        }
      },
    });
    if (pending.size === 0) {
      queueMicrotask(() => {
        if (this.pendingEose.get(upstreamSubId) === pending) {
          this.fireEose(upstreamSubId);
        }
      });
    }
  }

  closeSubscription(upstreamSubId: string): void {
    this.pendingEose.delete(upstreamSubId);
    this.resent.delete(upstreamSubId);
    this.defaultSubs.delete(upstreamSubId);
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

  onResentEose(callback: (upstreamSubId: string) => void): void {
    this.resentEoseCallback = callback;
  }

  onResend(callback: (relayUrl: string) => void): void {
    this.resendCallback = callback;
  }

  getConnectedCount(): number {
    return this.connectedUrls().length;
  }

  canReach(relayUrl: string): boolean {
    return this.temporary.canReach(relayUrl);
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
    const rxNostr = this.createClient('aggressive');
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

  private createClient(connectionStrategy: 'aggressive' | 'lazy'): RxNostr {
    return createRxNostr({
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
      // The default upstreams connect now ("aggressive"): the EOSE aggregate
      // only counts relays that are already up. Temporary ones connect on use.
      connectionStrategy,
      signer: PASSTHROUGH_SIGNER,
      retry: {
        strategy: 'exponential',
        maxCount: 5,
        initialDelay: this.options.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY,
      },
      websocketCtor: (this.options.webSocketFactory ?? (() => globalThis.WebSocket))(),
    });
  }

  /**
   * 既定の上流が全部、再試行中か諦めた状態なら自分側の断線とみなす。休止（dormant）は
   * 使っていないから閉じただけなので数えない。
   */
  private defaultsAllFailing(): boolean {
    const states = Object.values(this.rxNostr?.getAllRelayStatus() ?? {}).map((s) => s.connection);
    const failing = new Set(['waiting-for-retrying', 'retrying', 'error']);
    return states.length > 0 && states.every((state) => failing.has(state));
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
      this.markResent(from, this.defaultSubs);
      return;
    }
    this.dropFromPending(from);

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
    if (upstreamSubId) {
      this.settleRelay(upstreamSubId, relayUrl);
    }
  }

  /**
   * rx-nostr は EVENT を 1 マイクロタスク遅らせて流し（`filterAsync`。検証を切っている前提）、
   * EOSE は同期で渡す。同じタスクで続けて届くと EOSE が先に立つので、EVENT を待ってから数える。
   */
  private settleRelay(upstreamSubId: string, relayUrl: string): void {
    const pending = this.pendingEose.get(upstreamSubId);
    if (!pending) {
      this.settleResent(upstreamSubId, relayUrl);
      return;
    }
    queueMicrotask(() => {
      // 待つ間に同じ id で開き直された購読の分としては数えない
      if (this.pendingEose.get(upstreamSubId) === pending) {
        this.settlePending(upstreamSubId, pending, relayUrl);
      }
    });
  }

  private settlePending(upstreamSubId: string, pending: Set<string>, relayUrl: string): void {
    pending.delete(relayUrl);
    if (pending.size === 0) {
      this.fireEose(upstreamSubId);
    }
  }

  /**
   * 繋がったリレーへ rx-nostr が送る REQ の答えを待つ。集約 EOSE を待っている購読は除く。
   * その答えは集約に含まれ、別に EOSE を出すと 2 回になるため。
   */
  private markResent(relayUrl: string, upstreamSubIds: Iterable<string>): void {
    let marked = false;
    for (const upstreamSubId of upstreamSubIds) {
      if (this.pendingEose.has(upstreamSubId)) {
        continue;
      }
      let relays = this.resent.get(upstreamSubId);
      if (!relays) {
        relays = new Set();
        this.resent.set(upstreamSubId, relays);
      }
      relays.add(relayUrl);
      marked = true;
    }
    if (marked) {
      this.resendCallback?.(relayUrl);
    }
  }

  /** {@link settleRelay} と同じ理由で、手前の EVENT が流れ終わってから発火する。 */
  private settleResent(upstreamSubId: string, relayUrl: string): void {
    const relays = this.resent.get(upstreamSubId);
    if (!relays?.has(relayUrl)) {
      return;
    }
    queueMicrotask(() => {
      if (this.resent.get(upstreamSubId) !== relays || !relays.delete(relayUrl)) {
        return;
      }
      if (relays.size === 0) {
        this.resent.delete(upstreamSubId);
      }
      this.resentEoseCallback?.(upstreamSubId);
    });
  }

  /** そのリレーはもう答えないので、待っている購読から外す。 */
  private dropFromPending(relayUrl: string): void {
    for (const [upstreamSubId, relays] of this.resent) {
      if (relays.delete(relayUrl) && relays.size === 0) {
        this.resent.delete(upstreamSubId);
      }
    }
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

  /** Emit the aggregated EOSE exactly once, then forget the pending set. */
  private fireEose(upstreamSubId: string): void {
    if (this.pendingEose.delete(upstreamSubId)) {
      this.eoseCallback?.(upstreamSubId);
    }
  }
}
