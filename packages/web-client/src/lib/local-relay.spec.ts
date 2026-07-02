// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { EventSigner } from './event-signer.ts';
import type { LocalRelayHandle } from './local-relay.ts';
import { startLocalRelay } from './local-relay.ts';
import { RelayConnection } from './relay-connection.ts';

const TEST_URL = 'ws://localhost:4747';

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

/**
 * End-to-end wiring test: the in-process cache relay
 * (DexieStorage + WebSocketServerEmulator + NostrCacheRelay) must serve a
 * plain WebSocket client speaking NIP-01, without any real network.
 */
describe('startLocalRelay (integration)', () => {
  const originalWebSocket = globalThis.WebSocket;
  let handle: LocalRelayHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    globalThis.WebSocket = originalWebSocket;
  });

  it('serves publish → OK → REQ → EVENT → EOSE over the emulated WebSocket', async () => {
    handle = await startLocalRelay(TEST_URL);

    const okResults: Array<{ eventId: string; accepted: boolean }> = [];
    const connection = new RelayConnection({
      onOk: (eventId, accepted) => okResults.push({ eventId, accepted }),
    });
    await connection.connect(TEST_URL);
    expect(connection.isConnected).toBe(true);

    // Publish a signed kind-1 note and wait for the OK response.
    const signer = new EventSigner();
    const event = await signer.signTextNote('integration test note');
    connection.publish(event);
    await waitFor(() => okResults.length > 0, 'OK response');
    expect(okResults[0]).toEqual({ eventId: event.id, accepted: true });

    // Subscribe and receive the stored event followed by EOSE.
    const received: NostrEvent[] = [];
    let eoseReceived = false;
    connection.subscribe('it-sub', [{ kinds: [1], authors: [event.pubkey] }], {
      onEvent: (incoming) => received.push(incoming),
      onEose: () => {
        eoseReceived = true;
      },
    });
    await waitFor(() => eoseReceived, 'EOSE');
    expect(received.map((incoming) => incoming.id)).toContain(event.id);

    connection.disconnect();
    expect(connection.isConnected).toBe(false);
  });

  it('delivers live events to an open subscription after EOSE', async () => {
    handle = await startLocalRelay(TEST_URL);
    const connection = new RelayConnection();
    await connection.connect(TEST_URL);

    const signer = new EventSigner();
    const pubkey = await signer.getPublicKey();

    const received: NostrEvent[] = [];
    let eoseReceived = false;
    connection.subscribe('live-sub', [{ kinds: [1], authors: [pubkey] }], {
      onEvent: (incoming) => received.push(incoming),
      onEose: () => {
        eoseReceived = true;
      },
    });
    await waitFor(() => eoseReceived, 'EOSE');
    expect(received).toHaveLength(0);

    const event = await signer.signTextNote('live note');
    connection.publish(event);
    await waitFor(() => received.length > 0, 'live EVENT');
    expect(received[0].id).toBe(event.id);

    connection.disconnect();
  });
});
