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
import {
  type NostrEvent,
  NostrMessageType,
  type NostrWireMessage,
  getRandomSecret,
} from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Freshness window (`upstreamFreshness`) integration tests.
 *
 * Same two-relay setup as above, but the cache relay is built per test with a
 * configurable window so both the "fresh, upstream untouched" and the "expired,
 * upstream re-consulted" paths run over real sockets.
 *
 * The upstream holds a *newer* kind 0 for the same author than the cache does,
 * so "the upstream was not consulted" is directly observable: the client either
 * sees the stale cached profile only, or it also sees the upstream one.
 */
describe('Freshness window integration', () => {
  /** Upstream EOSE budget; a skipped upstream must beat this by a wide margin. */
  const EOSE_TIMEOUT = 3000;

  let upstream: IntegrationTestBase;
  let cacheStorage: DexieStorage;
  let cacheServer: WebSocketServer;
  let cacheRelay: NostrCacheRelay;
  let pool: UpstreamRelayPool;
  let cacheUrl: string;

  /** Author shared by the cached and the upstream profile. */
  let seckey: string;
  /** kind 0 held by the cache. */
  let cachedProfile: NostrEvent;
  /** Newer kind 0 held only by the upstream. */
  let upstreamProfile: NostrEvent;

  beforeEach(async () => {
    upstream = new IntegrationTestBase(0);
    await upstream.setup();

    seckey = getRandomSecret();
    cachedProfile = await createTestEvent(seckey, {
      kind: 0,
      created_at: 1_000_000,
      content: '{"name":"cached"}',
    });
    upstreamProfile = await createTestEvent(seckey, {
      kind: 0,
      created_at: 2_000_000,
      content: '{"name":"upstream"}',
    });
    await upstream.storage.saveEvent(upstreamProfile);

    cacheStorage = new DexieStorage('CacheRelayFreshnessIntegrationDb');
    cacheServer = new WebSocketServer(0);
    pool = new UpstreamRelayPool([upstream.getServerUrl()], { connectionTimeout: 2000 });
  });

  afterEach(async () => {
    await cacheRelay.disconnect();
    await cacheStorage.clear();
    await cacheStorage.delete();
    await upstream.teardown();
  });

  /**
   * Start the cache relay with the given window and seed the cached profile,
   * backdated by `cachedSecondsAgo` so its `cached_at` is deterministic.
   */
  async function startRelay(windowSeconds: number, cachedSecondsAgo: number): Promise<void> {
    // saveEvent stamps cached_at from Date.now(); backdate it to control freshness
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - cachedSecondsAgo * 1000);
    await cacheStorage.saveEvent(cachedProfile, { validated: true });
    nowSpy.mockRestore();

    cacheRelay = new NostrCacheRelay(cacheStorage, cacheServer, {
      upstreamPool: pool,
      upstreamEoseTimeout: EOSE_TIMEOUT,
      upstreamFreshness: { 0: windowSeconds },
    });
    await cacheRelay.connect();
    cacheUrl = `ws://localhost:${cacheServer.getPort()}`;
    await waitFor(() => pool.getConnectedCount() > 0);
  }

  it('serves a fresh kind 0 from cache without consulting the upstream', async () => {
    await startRelay(3600, 60);

    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [0], authors: [cachedProfile.pubkey] }]));

    await waitForMessage(client, NostrMessageType.EOSE);
    // Give an (erroneous) upstream round-trip time to land.
    await delay(400);

    const ids = received
      .filter((m) => m[0] === NostrMessageType.EVENT)
      .map((m) => (m[2] as NostrEvent).id);
    expect(ids).toEqual([cachedProfile.id]);
    // 上流の新しい版は届かない = REQ が転送されていない
    expect(ids).not.toContain(upstreamProfile.id);

    client.close();
  });

  it('returns EOSE immediately instead of waiting out upstreamEoseTimeout', async () => {
    await startRelay(3600, 60);

    const client = await openClient(cacheUrl);
    const started = Date.now();
    const eosePromise = waitForMessage(client, NostrMessageType.EOSE);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [0], authors: [cachedProfile.pubkey] }]));
    await eosePromise;

    expect(Date.now() - started).toBeLessThan(EOSE_TIMEOUT / 2);

    client.close();
  });

  it('re-consults the upstream once the window has expired', async () => {
    // 2 時間前にキャッシュ → 1 時間の窓を超過
    await startRelay(3600, 7200);

    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [0], authors: [cachedProfile.pubkey] }]));

    await waitFor(() =>
      received.some(
        (m) => m[0] === NostrMessageType.EVENT && (m[2] as NostrEvent).id === upstreamProfile.id
      )
    );

    // 新しい版がローカルへ充填され、置換で古い版が消えている
    await waitFor(async () => {
      const stored = await cacheStorage.getEvents([
        { kinds: [0], authors: [cachedProfile.pubkey] },
      ]);
      return stored.length === 1 && stored[0].id === upstreamProfile.id;
    });

    client.close();
  });

  it('still forwards a filter the window cannot satisfy (regular kind)', async () => {
    await startRelay(3600, 60);
    const note = await createTestEvent(seckey, { kind: 1 });
    await upstream.storage.saveEvent(note);

    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [note.pubkey] }]));

    await waitFor(() =>
      received.some((m) => m[0] === NostrMessageType.EVENT && (m[2] as NostrEvent).id === note.id)
    );

    client.close();
  });

  it('does not deliver live upstream updates for a skipped subscription', async () => {
    await startRelay(3600, 60);

    const client = await openClient(cacheUrl);
    const received = collectMessages(client);
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [0], authors: [cachedProfile.pubkey] }]));
    await waitForMessage(client, NostrMessageType.EOSE);

    // 窓の内側では上流購読を持たないため、以降のライブ更新は届かない
    // （HTTP キャッシュと同じ「次回 REQ で再検証」セマンティクス）
    const newer = await createTestEvent(seckey, {
      kind: 0,
      created_at: 3_000_000,
      content: '{"name":"live"}',
    });
    const publisher = await openClient(upstream.getServerUrl());
    publisher.send(JSON.stringify(['EVENT', newer]));
    await delay(400);

    const delivered = received.filter(
      (m) => m[0] === NostrMessageType.EVENT && (m[2] as NostrEvent).id === newer.id
    );
    expect(delivered).toHaveLength(0);

    publisher.close();
    client.close();
  });
});
