import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type {
  ConnectionState,
  EventSigner,
  LazyFilter,
  MessagePacket,
  RetryConfig,
  RxNostr,
} from 'rx-nostr';
import { createRxForwardReq, createRxNostr } from 'rx-nostr';

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
 * Auto-reconnection policy.
 *
 * The relay on the other end is in this very page, so holding the socket open
 * costs nothing and a drop is always worth chasing: it means the page's relay
 * was torn down and restarted, not that a server is refusing us. Hence a longer
 * retry ladder than rx-nostr's default of five — exponential backoff caps the
 * traffic anyway, and giving up would leave the widget stuck on a stale
 * timeline with no way back.
 */
const RETRY: RetryConfig = { strategy: 'exponential', maxCount: 10, initialDelay: 1000 };

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
 * Map rx-nostr's connection state onto the four states the UI renders.
 *
 * `waiting-for-retrying` and `retrying` are the auto-reconnect ladder, and are
 * reported apart from the first `connecting` so the UI can say "reconnecting"
 * rather than implying the user is waiting on an initial connection.
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

/**
 * Whether a state means the connection attempt in progress has failed.
 *
 * `error` and `rejected` are terminal, and the two retry states say rx-nostr
 * has given up on the current attempt and fallen back to the backoff ladder.
 */
function isFailedAttempt(state: ConnectionState): boolean {
  return (
    state === 'error' ||
    state === 'rejected' ||
    state === 'waiting-for-retrying' ||
    state === 'retrying'
  );
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
   * Connect to a relay. Resolves once the socket is open; rejects if the first
   * attempt fails. An existing connection is closed first.
   *
   * Only the *first* attempt is reported to the caller: once it has succeeded,
   * later drops are rx-nostr's to recover from and are visible through
   * {@link RelayConnectionOptions.onStatusChange} instead. A first attempt that
   * fails tears the client down rather than retrying in the background, so a
   * rejected connect() leaves nothing running — which is what callers that
   * report "接続に失敗しました" and stop already assume.
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
      retry: RETRY,
      signer: PASSTHROUGH_SIGNER,
      // Left undefined, rx-nostr reads globalThis.WebSocket when it opens the
      // socket — which is after the emulator has patched it, as it must be.
      websocketCtor: this.options.webSocketCtor,
    });
    this.rxNostr = rxNostr;

    return new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      let connectedOnce = false;

      const states = rxNostr.createConnectionStateObservable().subscribe(({ state }) => {
        if (state === 'connected') {
          connectedOnce = true;
          this.setStatus('connected');
          this.settleConnect(null);
          return;
        }
        if (!connectedOnce && isFailedAttempt(state)) {
          // Report it as an error rather than as a reconnection: nobody has
          // been connected yet, so there is nothing to reconnect *to* from the
          // caller's point of view, and connect() is about to reject.
          this.teardownClient('error');
          this.settleConnect(new Error(`Failed to connect to ${url}`));
          return;
        }
        this.setStatus(toStatus(state));
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
    // relay-to-client message, so this subscription only drives the send.
    this.rxNostr?.send(event as never).subscribe({ error: () => {} });
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
