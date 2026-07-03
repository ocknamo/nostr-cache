import {
  DexieStorage,
  NostrCacheRelay,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';

/**
 * URL served by the in-browser cache relay. Connections to this URL are
 * intercepted by WebSocketServerEmulator and never reach the network.
 * The RFC 6761 reserved `.invalid` TLD guarantees no real server can ever
 * exist at this address, even if the emulator is not running.
 */
export const LOCAL_RELAY_URL = 'ws://nostr-cache.invalid';

export interface LocalRelayHandle {
  relay: NostrCacheRelay;
  stop: () => Promise<void>;
}

/**
 * Options for {@link startLocalRelay}.
 */
export interface StartLocalRelayOptions {
  /**
   * Upstream relay URLs (`wss://…`). When provided, the local relay becomes a
   * transparent cache in front of them: REQ is read-through (forwarded upstream,
   * results backfilled locally) and EVENT is write-through (forwarded upstream).
   * When omitted, the relay only serves events it already holds locally.
   *
   * The emulator only intercepts {@link LOCAL_RELAY_URL}; upstream `wss://` URLs
   * go out over the real (pre-patch) WebSocket, so they never loop back here.
   */
  upstreamRelays?: string[];
}

/**
 * Boot the in-browser local cache relay:
 * DexieStorage (IndexedDB) + WebSocketServerEmulator + NostrCacheRelay.
 *
 * After this resolves, `new WebSocket(url)` for the given URL is served by
 * the local relay (NIP-01 over an emulated socket). Pass `upstreamRelays` to
 * make it a transparent cache in front of real relays (read/write-through).
 */
export async function startLocalRelay(
  url: string = LOCAL_RELAY_URL,
  options: StartLocalRelayOptions = {}
): Promise<LocalRelayHandle> {
  const storage = new DexieStorage('nostr-cache-web-client');
  const transport = new WebSocketServerEmulator(url);
  const relay = new NostrCacheRelay(storage, transport, {
    validateEventsType: 'IMMEDIATELY',
    maxSubscriptions: 20,
    upstreamRelays: options.upstreamRelays,
  });
  await relay.connect();
  return {
    relay,
    stop: () => relay.disconnect(),
  };
}
