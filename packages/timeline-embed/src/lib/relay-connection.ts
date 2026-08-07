import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { ConnectionState, EventSigner, LazyFilter, MessagePacket, RxNostr } from 'rx-nostr';
import { createRxForwardReq, createRxNostr, createRxOneshotReq } from 'rx-nostr';

/**
 * Deadline on a {@link RelayConnection.fetchOnce}, in milliseconds.
 *
 * Covers the relay's upstream EOSE timeout (3s) with room to spare. Its real
 * job is the case where no reply of any kind arrives.
 */
export const ONE_SHOT_TIMEOUT_MS = 5000;

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

export interface SubscriptionHandlers {
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  onClosed?: (message?: string) => void;
}

export interface RelayConnectionOptions {
  /** WebSocket constructor to use (defaults to globalThis.WebSocket) */
  webSocketCtor?: typeof WebSocket;
  onStatusChange?: (status: ConnectionStatus) => void;
  onNotice?: (message: string) => void;
  onOk?: (eventId: string, accepted: boolean, message?: string) => void;
}

/**
 * The widget never signs: {@link RelayConnection.publish} takes an event that
 * is already signed, so "signing" is the identity function. Declaring it keeps
 * rx-nostr's default NIP-07 signer — and its reach for `window.nostr` — out of
 * a widget that has no business prompting for a browser extension.
 */
const PASSTHROUGH_SIGNER: EventSigner = {
  signEvent: async (event) => event as never,
  getPublicKey: async () => {
    throw new Error('RelayConnection does not sign; publish() takes a signed event');
  },
};

/**
 * Wire subscription ID rx-nostr uses for a forward-strategy REQ.
 *
 * rx-nostr builds it as `${rxReqId}:${childId}`, and the child ID is pinned to
 * 0 under the forward strategy (a forward REQ overwrites its predecessor rather
 * than opening a second one). Passing the caller's ID as the `rxReqId` therefore
 * makes the wire ID derivable, which is what lets EOSE and CLOSED — which arrive
 * on the shared message stream, not through `use()` — be routed back to the
 * right handlers.
 */
function wireSubId(subId: string): string {
  return `${subId}:0`;
}

/**
 * Map rx-nostr's connection state onto the states the UI renders.
 *
 * `waiting-for-retrying` and `retrying` are the auto-reconnect ladder, and are
 * reported apart from `connecting` so the UI can say the connection is being
 * retried rather than implying a first attempt is still in flight.
 */
function toStatus(state: ConnectionState): ConnectionStatus {
  switch (state) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'waiting-for-retrying':
    case 'retrying':
      return 'reconnecting';
    case 'error':
    case 'rejected':
      return 'error';
    default:
      // `initialized`, `dormant` and `terminated`: no socket, nothing pending.
      return 'disconnected';
  }
}

/** What we hold on to for one live subscription. */
interface ActiveSubscription {
  handlers: SubscriptionHandlers;
  /** Unsubscribing sends CLOSE and stops routing events. */
  events: { unsubscribe(): void };
}

/**
 * NIP-01 relay client backed by rx-nostr.
 *
 * Framework-agnostic: all UI state is driven through the callbacks in
 * {@link RelayConnectionOptions} and {@link SubscriptionHandlers}. The
 * WebSocket constructor is injectable for tests.
 *
 * Relay management — reconnecting with exponential backoff, re-issuing the REQs
 * that were open when the socket dropped, buffering messages sent while it is
 * down — is rx-nostr's job, not this class's. That is the whole reason it is
 * here: a subscription now survives the page's relay being torn down and
 * restarted, where the previous hand-rolled client dropped every subscription
 * on close and left the widget with no way back.
 *
 * Signature verification is deliberately switched off (`skipVerify`). The cache
 * relay this talks to verifies every event itself and persists the verdict — see
 * `relay-host.ts` — so verifying again here would spend the reader's CPU on
 * crypto that has already been done, and pull a second signature implementation
 * into the embed bundle.
 */
export class RelayConnection {
  private rxNostr?: RxNostr;
  /** Live subscriptions, keyed by their wire subscription ID. */
  private subscriptions = new Map<string, ActiveSubscription>();
  private teardown: (() => void)[] = [];
  private status: ConnectionStatus = 'disconnected';
  /** Settles the in-flight connect(), if there is one. */
  private pendingConnect?: { resolve: () => void; reject: (error: Error) => void };
  private readonly options: RelayConnectionOptions;

  constructor(options: RelayConnectionOptions = {}) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  /**
   * Connect to a relay. Resolves once the socket is open; rejects once rx-nostr
   * has given up on it. An existing connection is closed first.
   *
   * "Given up" is rx-nostr's call, not this class's: a connection that drops —
   * whether or not it ever came up — goes onto its retry ladder, and only the
   * terminal `error`/`rejected` states mean nobody is trying any more. So a
   * first attempt that fails does not reject here; it is reported as
   * `reconnecting` through {@link RelayConnectionOptions.onStatusChange} and
   * resolves normally if a later attempt lands. A rejected connect() leaves
   * nothing running, which is what callers that report a failure and stop
   * already assume.
   */
  connect(url: string): Promise<void> {
    this.disconnect();
    this.setStatus('connecting');

    const rxNostr = createRxNostr({
      // The cache relay verifies signatures itself and persists the verdict.
      skipVerify: true,
      // The in-page relay is a WebSocket and nothing else: there is no HTTP
      // origin to serve a NIP-11 document, and `.invalid` never resolves.
      skipFetchNip11: true,
      // Hold the socket open. The default ("lazy") drops an idle connection
      // after ten seconds, which for an in-page relay buys nothing and costs a
      // reconnect on the next profile lookup.
      connectionStrategy: 'aggressive',
      // Bounds a one-shot fetch: rx-nostr's backward strategy pipes its event
      // stream through `completeOnTimeout(eoseTimeout)`, so this is the deadline
      // for {@link fetchOnce} when a REQ draws no reply at all — the relay
      // answers a refusal (subscription cap, storage read failure) with a NOTICE
      // and neither EOSE nor CLOSED. The default is 30s, far too long to leave a
      // widget waiting; 5s covers the relay's own upstream EOSE timeout (3s)
      // with room to spare.
      eoseTimeout: ONE_SHOT_TIMEOUT_MS,
      signer: PASSTHROUGH_SIGNER,
      // Left undefined, rx-nostr reads globalThis.WebSocket when it opens the
      // socket — which is after the emulator has patched it, as it must be.
      websocketCtor: this.options.webSocketCtor,
      // `retry` is deliberately left at rx-nostr's default (exponential backoff
      // with jitter, five attempts). Reconnection is the reason this class went
      // through rx-nostr at all, so there is no policy of our own to impose.
    });
    this.rxNostr = rxNostr;

    return new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };

      const states = rxNostr.createConnectionStateObservable().subscribe(({ state }) => {
        this.setStatus(toStatus(state));
        if (state === 'connected') {
          this.settleConnect(null);
        } else if (state === 'error' || state === 'rejected') {
          // Terminal: the retries are spent, or the relay told us not to come
          // back. Nothing is going to change on its own from here.
          this.settleConnect(new Error(`Failed to connect to ${url}`));
          this.teardownClient('error');
        }
      });
      this.teardown.push(() => states.unsubscribe());

      // EOSE, CLOSED, NOTICE and OK do not come through `use()` — it carries
      // events only — so one shared stream routes them.
      const messages = rxNostr
        .createAllMessageObservable()
        .subscribe((packet) => this.handleMessage(packet));
      this.teardown.push(() => messages.unsubscribe());

      try {
        rxNostr.setDefaultRelays([url]);
      } catch (error) {
        this.teardownClient('error');
        this.settleConnect(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Close the connection (if any) and drop all subscriptions.
   */
  disconnect(): void {
    this.teardownClient('disconnected');
    this.settleConnect(new Error('Connection closed before opening'));
  }

  /**
   * Drop the rx-nostr client and everything hanging off it.
   *
   * @param status Status to report, but only if there was a client to drop —
   *   calling disconnect() on an idle connection stays silent, as it always has.
   */
  private teardownClient(status: ConnectionStatus): void {
    const rxNostr = this.rxNostr;
    this.rxNostr = undefined;

    for (const { events } of this.subscriptions.values()) {
      events.unsubscribe();
    }
    this.subscriptions.clear();

    // Detach before disposing so rx-nostr's own `terminated` transition does
    // not race the status this reports.
    const teardown = this.teardown;
    this.teardown = [];
    for (const off of teardown) {
      off();
    }

    if (rxNostr) {
      rxNostr.dispose();
      this.setStatus(status);
    }
  }

  /**
   * Open a subscription: sends REQ and routes matching EVENT/EOSE/CLOSED
   * messages to the given handlers.
   *
   * A REQ issued while the socket is down is not lost: rx-nostr buffers it and
   * sends it on connect, and re-sends it after a reconnect for as long as the
   * subscription is open.
   */
  subscribe(subId: string, filters: Filter[], handlers: SubscriptionHandlers): void {
    const rxNostr = this.rxNostr;
    if (!rxNostr) {
      return;
    }
    // Reusing an ID replaces the subscription rather than shadowing it.
    this.unsubscribe(subId);

    const req = createRxForwardReq(subId);
    // Subscribe before emitting: the request stream is hot, so a filter emitted
    // first would be dropped and no REQ would ever be sent.
    const events = rxNostr.use(req).subscribe(({ event }) => {
      handlers.onEvent(event as NostrEvent);
    });
    this.subscriptions.set(wireSubId(subId), { handlers, events });
    req.emit(filters as LazyFilter[]);
  }

  /**
   * Issue one REQ, collect what it returns, and close it again.
   *
   * rx-nostr's oneshot strategy does the work: its backward event observable
   * completes when every target relay has finished the subscription (EOSE or
   * CLOSED), pipes itself through `completeOnTimeout(eoseTimeout)` so a REQ that
   * draws no reply cannot hang, and `finalize`s into a CLOSE on every path. All
   * three used to be hand-rolled here.
   *
   * Closing on EOSE is only correct because our relay orders EOSE *after* the
   * events it has accepted (`UpstreamCoordinator.flushEose` waits for its ingest
   * chain). Against a relay that releases EOSE early this would drop events that
   * were already on their way.
   *
   * @param filters Filters for the REQ; they travel as one subscription
   * @param options `signal` abandons the fetch — the subscription is closed and
   *   the promise resolves with nothing rather than a partial answer, because a
   *   caller being torn down should not act on half a result
   * @returns Every event that arrived, in arrival order
   */
  fetchOnce(filters: Filter[], options: { signal?: AbortSignal } = {}): Promise<NostrEvent[]> {
    const rxNostr = this.rxNostr;
    if (!rxNostr || options.signal?.aborted) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const req = createRxOneshotReq({ filters: filters as LazyFilter[] });
      const subscription = rxNostr.use(req).subscribe({
        next: ({ event }) => {
          events.push(event as NostrEvent);
        },
        complete: () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(events);
        },
        // A stream-level failure is not distinguishable from an empty answer by
        // anyone upstream of here, and the callers all treat "nothing" as "could
        // not fetch it" — so report that rather than rejecting.
        error: () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve([]);
        },
      });

      function onAbort(): void {
        // Unsubscribing runs rx-nostr's `finalize`, which sends the CLOSE.
        subscription.unsubscribe();
        resolve([]);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Close a subscription: sends CLOSE and stops routing its messages.
   */
  unsubscribe(subId: string): void {
    const entry = this.subscriptions.get(wireSubId(subId));
    if (!entry) {
      return;
    }
    this.subscriptions.delete(wireSubId(subId));
    entry.events.unsubscribe();
  }

  /**
   * Publish an event. The result arrives via the onOk callback.
   */
  publish(event: NostrEvent): void {
    // OK is routed from the shared message stream with every other
    // relay-to-client message, so this subscription only drives the send and is
    // done the moment the EVENT has gone out. Waiting for the OK here — the
    // default — would instead hold it open until every relay has answered or
    // the 30s timeout expires, once per published event.
    this.rxNostr?.send(event as never, { completeOn: 'sent' }).subscribe({ error: () => {} });
  }

  private settleConnect(error: Error | null): void {
    const pending = this.pendingConnect;
    if (!pending) {
      return;
    }
    this.pendingConnect = undefined;
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private handleMessage(packet: MessagePacket): void {
    switch (packet.type) {
      case 'EOSE': {
        this.subscriptions.get(packet.subId)?.handlers.onEose?.();
        break;
      }
      case 'CLOSED': {
        const entry = this.subscriptions.get(packet.subId);
        if (entry) {
          // The relay has already dropped it, so stop routing before telling
          // the caller. rx-nostr knows it is gone too and sends no CLOSE.
          this.subscriptions.delete(packet.subId);
          entry.events.unsubscribe();
          entry.handlers.onClosed?.(packet.notice);
        }
        break;
      }
      case 'NOTICE': {
        this.options.onNotice?.(packet.notice);
        break;
      }
      case 'OK': {
        this.options.onOk?.(packet.eventId, packet.ok, packet.notice);
        break;
      }
      default:
        // EVENT is delivered through use(); anything else is not ours.
        break;
    }
  }
}
