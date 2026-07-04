/**
 * Upstream read-through / write-through integration tests.
 *
 * A real upstream relay is stood up with {@link IntegrationTestBase} (a
 * `WebSocketServer` + `MessageHandler` + `DexieStorage`). A separate cache
 * relay — a full {@link NostrCacheRelay} over its own `WebSocketServer` and
 * `DexieStorage` — is pointed at it via a real {@link UpstreamRelayPool}
 * (native WebSocket). Everything runs over real sockets end-to-end.
 */

// Register fake-indexeddb before anything pulls in Dexie (DexieStorage below),
// otherwise Dexie evaluates without a global indexedDB and throws MissingAPIError.
import 'fake-indexeddb/auto';
import { type NostrEvent, NostrMessageType, type NostrWireMessage } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NostrCacheRelay } from '../core/nostr-cache-relay.js';
import { DexieStorage } from '../storage/dexie-storage.js';
import { WebSocketServer } from '../transport/web-socket-server.js';
import { UpstreamRelayPool } from '../upstream/upstream-relay-pool.js';
import { IntegrationTestBase, createTestEvent } from './utils/base.integration.js';

/** Open a client WebSocket and resolve once it is OPEN. */
function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
  });
}

/** Resolve with the first message of `type` received on `ws`. */
function waitForMessage(ws: WebSocket, type: NostrMessageType): Promise<NostrWireMessage> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as NostrWireMessage;
      if (message[0] === type) {
        ws.removeEventListener('message', handler);
        resolve(message);
      }
    };
    ws.addEventListener('message', handler);
  });
}

/** Collect every message received on `ws` (for asserting counts / absence). */
function collectMessages(ws: WebSocket): NostrWireMessage[] {
  const received: NostrWireMessage[] = [];
  ws.addEventListener('message', (event) => {
    received.push(JSON.parse((event as MessageEvent).data) as NostrWireMessage);
  });
  return received;
}

/** Poll `predicate` until true or the timeout elapses. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: condition not met within timeout');
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Upstream read/write-through integration', () => {
  let upstream: IntegrationTestBase;
  let cacheStorage: DexieStorage;
  let cacheServer: WebSocketServer;
  let cacheRelay: NostrCacheRelay;
  let pool: UpstreamRelayPool;
  let cacheUrl: string;

  beforeEach(async () => {
    upstream = new IntegrationTestBase(0);
    await upstream.setup();

    cacheStorage = new DexieStorage('CacheRelayUpstreamIntegrationDb');
    cacheServer = new WebSocketServer(0);
    pool = new UpstreamRelayPool([upstream.getServerUrl()], { connectionTimeout: 2000 });
    cacheRelay = new NostrCacheRelay(cacheStorage, cacheServer, {
      upstreamPool: pool,
      upstreamEoseTimeout: 500,
    });
    await cacheRelay.connect();
    cacheUrl = `ws://localhost:${cacheServer.getPort()}`;

    // Wait until the cache relay has actually connected to the upstream, so the
    // EOSE aggregation counts it and reads flow through deterministically.
    await waitFor(() => pool.getConnectedCount() > 0);
  });

  afterEach(async () => {
    await cacheRelay.disconnect();
    await cacheStorage.clear();
    await cacheStorage.delete();
    // upstream.teardown() clears its storage and resets the shared indexedDB.
    await upstream.teardown();
  });

  it('read-through: fetches an upstream-only event, delivers it and backfills locally', async () => {
    const event = await createTestEvent();
    // The event exists only upstream.
    await upstream.storage.saveEvent(event);

    const client = await openClient(cacheUrl);
    const eventPromise = waitForMessage(client, NostrMessageType.EVENT);
    const eosePromise = waitForMessage(client, NostrMessageType.EOSE);

    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [event.pubkey] }]));

    const eventMessage = await eventPromise;
    expect((eventMessage[2] as NostrEvent).id).toBe(event.id);
    await eosePromise;

    // The upstream event was backfilled into the cache's own storage.
    await waitFor(async () => (await cacheStorage.getEvents([{ ids: [event.id] }])).length === 1);

    client.close();
  });

  it('read-through: a second REQ is served from the local cache (backfilled)', async () => {
    const event = await createTestEvent();
    await upstream.storage.saveEvent(event);

    // First REQ backfills the event locally.
    const client1 = await openClient(cacheUrl);
    const first = waitForMessage(client1, NostrMessageType.EVENT);
    client1.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [event.pubkey] }]));
    await first;
    client1.close();

    await waitFor(async () => (await cacheStorage.getEvents([{ ids: [event.id] }])).length === 1);

    // Remove it upstream: a second REQ can only be answered from local storage.
    await upstream.storage.deleteEvent(event.id);

    const client2 = await openClient(cacheUrl);
    const second = waitForMessage(client2, NostrMessageType.EVENT);
    client2.send(JSON.stringify(['REQ', 'sub2', { kinds: [1], authors: [event.pubkey] }]));
    expect((await second)[2]).toMatchObject({ id: event.id });
    client2.close();
  });

  it('write-through: an event published to the cache is forwarded upstream', async () => {
    const event = await createTestEvent();
    const client = await openClient(cacheUrl);
    const okPromise = waitForMessage(client, NostrMessageType.OK);

    client.send(JSON.stringify(['EVENT', event]));

    const ok = await okPromise;
    expect(ok[1]).toBe(event.id);
    expect(ok[2]).toBe(true);

    // The event reaches the upstream relay's storage (fire-and-forget forward).
    await waitFor(
      async () => (await upstream.storage.getEvents([{ ids: [event.id] }])).length === 1
    );

    client.close();
  });

  it('live: an event published upstream after EOSE reaches the subscribed client', async () => {
    const client = await openClient(cacheUrl);
    const eosePromise = waitForMessage(client, NostrMessageType.EOSE);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]));
    await eosePromise;

    // Now publish a fresh event straight to the upstream relay.
    const liveEvent = await createTestEvent();
    const eventPromise = waitForMessage(client, NostrMessageType.EVENT);
    const publisher = await openClient(upstream.getServerUrl());
    publisher.send(JSON.stringify(['EVENT', liveEvent]));

    const delivered = await eventPromise;
    expect((delivered[2] as NostrEvent).id).toBe(liveEvent.id);

    publisher.close();
    client.close();
  });

  it('dedup: an event held both locally and upstream is delivered once', async () => {
    const event = await createTestEvent();
    // Present in both stores.
    await upstream.storage.saveEvent(event);
    await cacheStorage.saveEvent(event);

    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [event.pubkey] }]));

    // Wait for EOSE, then give any (erroneous) duplicate a chance to arrive.
    await waitForMessage(client, NostrMessageType.EOSE);
    await delay(200);

    const eventMessages = received.filter(
      (m) => m[0] === NostrMessageType.EVENT && (m[2] as NostrEvent).id === event.id
    );
    expect(eventMessages).toHaveLength(1);

    client.close();
  });

  it('CLOSE stops live delivery from upstream', async () => {
    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]));
    await waitForMessage(client, NostrMessageType.EOSE);

    // Close the subscription, then publish upstream.
    client.send(JSON.stringify(['CLOSE', 'sub1']));
    await waitForMessage(client, NostrMessageType.CLOSED);

    const liveEvent = await createTestEvent();
    const publisher = await openClient(upstream.getServerUrl());
    publisher.send(JSON.stringify(['EVENT', liveEvent]));
    await delay(300);

    const delivered = received.filter(
      (m) => m[0] === NostrMessageType.EVENT && (m[2] as NostrEvent).id === liveEvent.id
    );
    expect(delivered).toHaveLength(0);

    publisher.close();
    client.close();
  });
});
