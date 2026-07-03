/**
 * Types for the upstream relay layer.
 *
 * The upstream layer turns the local cache relay into a transparent cache in
 * front of real (upstream) relays: read-through (REQ is forwarded upstream and
 * fetched events are backfilled locally) and write-through (published EVENTs
 * are forwarded upstream). See `doc/cache-relay/upstream.md`.
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';

/**
 * Abstraction over a set of upstream relay connections.
 *
 * The concrete implementation is {@link UpstreamRelayPool}; tests inject a mock
 * to drive the {@link UpstreamCoordinator} without real sockets.
 *
 * Subscription identity is expressed with an opaque `upstreamSubId` chosen by
 * the caller (the coordinator). It must satisfy NIP-01's 64-character limit —
 * the coordinator generates short ids and keeps its own mapping back to the
 * client subscription, rather than trying to encode client/sub ids into it.
 */
export interface UpstreamPool {
  /**
   * Begin connecting to every upstream relay. Resolves once connection attempts
   * have been kicked off; individual relays connect (and reconnect) in the
   * background, so a relay being down never rejects this call.
   */
  start(): Promise<void>;

  /** Close every connection and drop all subscriptions. */
  stop(): Promise<void>;

  /**
   * Forward an EVENT to every connected upstream (fire-and-forget). Events for
   * relays that are not currently connected are dropped (no offline queue).
   */
  publish(event: NostrEvent): void;

  /**
   * Open a subscription (REQ) on every upstream with the given filters. The
   * `upstreamSubId` is chosen by the caller and used to correlate EVENT/EOSE
   * callbacks and to close the subscription later.
   */
  openSubscription(upstreamSubId: string, filters: Filter[]): void;

  /** Close a subscription (CLOSE) on every upstream. */
  closeSubscription(upstreamSubId: string): void;

  /** Register a callback for EVENTs received from any upstream (raw, unvalidated). */
  onEvent(callback: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void): void;

  /**
   * Register a callback fired once per subscription when every relay that was
   * connected at `openSubscription` time has returned EOSE (or immediately when
   * no relay was connected). Relays that connect later do not participate, so a
   * down relay never stalls the aggregated EOSE forever.
   */
  onEose(callback: (upstreamSubId: string) => void): void;

  /** Number of upstream relays whose connection is currently established. */
  getConnectedCount(): number;
}

/**
 * Options for {@link UpstreamRelayPool} (and, individually, each connection).
 */
export interface UpstreamPoolOptions {
  /** Per-connection connect timeout in ms. Default `DEFAULT_CONNECTION_TIMEOUT`. */
  connectionTimeout?: number;
  /**
   * Maximum number of relays to connect to. URLs beyond this are ignored with a
   * warning. Default `DEFAULT_MAX_CONCURRENT_RELAYS`.
   */
  maxRelays?: number;
  /** Base delay in ms for exponential reconnect backoff. Default 1000. */
  reconnectBaseDelay?: number;
  /** Maximum reconnect backoff delay in ms. Default 60000. */
  reconnectMaxDelay?: number;
  /**
   * Lazy factory for the `WebSocket` constructor to use. Evaluated at connect
   * time (not construction) so that, in the browser, the connector reaches the
   * pre-patch `WebSocket` even when the emulator later replaces the global —
   * avoiding a self-connection loop for an intercepted upstream URL. Defaults
   * to `() => globalThis.WebSocket`.
   */
  webSocketFactory?: () => typeof WebSocket;
}
