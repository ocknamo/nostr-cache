import {
  DexieStorage,
  NostrCacheRelay,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';

/**
 * URL served by the in-browser cache relay. Connections to this URL are
 * intercepted by WebSocketServerEmulator and never reach the network.
 */
export const LOCAL_RELAY_URL = 'ws://localhost:3000';

export interface LocalRelayHandle {
  relay: NostrCacheRelay;
  stop: () => Promise<void>;
}

/**
 * Boot the in-browser local cache relay:
 * DexieStorage (IndexedDB) + WebSocketServerEmulator + NostrCacheRelay.
 *
 * After this resolves, `new WebSocket(url)` for the given URL is served by
 * the local relay (NIP-01 over an emulated socket).
 */
export async function startLocalRelay(url: string = LOCAL_RELAY_URL): Promise<LocalRelayHandle> {
  const storage = new DexieStorage('nostr-cache-web-client');
  const transport = new WebSocketServerEmulator(url);
  const relay = new NostrCacheRelay(storage, transport, {
    validateEventsType: 'IMMEDIATELY',
    maxSubscriptions: 20,
  });
  await relay.connect();
  return {
    relay,
    stop: () => relay.disconnect(),
  };
}
