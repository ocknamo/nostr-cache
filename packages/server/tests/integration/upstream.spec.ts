/**
 * Smoke test for the server-level upstream (read/write-through) option.
 *
 * Two NostrRelayServer instances are started: an "upstream" relay and a
 * "cache" relay configured with `relay.upstreamRelays` pointing at the
 * upstream. Verifies that publishing to the cache reaches the upstream
 * (write-through) and that an upstream-only event is served through the cache
 * (read-through). The detailed behaviour is covered by the cache-relay
 * integration tests; this only confirms the option is wired through the server.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { createTestEvent } from '../utils/test-events.js';

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
  });
}

function waitForMatch(
  ws: WebSocket,
  predicate: (message: unknown[]) => boolean,
  timeout = 4000
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMatch: timed out')), timeout);
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (predicate(message)) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NostrRelayServer upstream option', () => {
  let upstream: NostrRelayServer;
  let cache: NostrRelayServer;
  let upstreamPort: number;
  let cachePort: number;

  beforeEach(async () => {
    upstreamPort = Math.floor(Math.random() * 10000) + 20000;
    cachePort = upstreamPort + 1;

    upstream = new NostrRelayServer({
      port: upstreamPort,
      storageOptions: { dbName: 'UpstreamRelayDb' },
      healthCheck: { enabled: false },
    });
    await upstream.start();

    cache = new NostrRelayServer({
      port: cachePort,
      storageOptions: { dbName: 'CacheRelayDb' },
      healthCheck: { enabled: false },
      relay: {
        upstreamRelays: [`ws://localhost:${upstreamPort}`],
        upstreamEoseTimeout: 500,
      },
    });
    await cache.start();
    // Give the cache relay a moment to establish its upstream connection.
    await delay(300);
  });

  afterEach(async () => {
    await cache.stop();
    await upstream.stop();
  });

  it('write-through: an event published to the cache reaches the upstream', async () => {
    const event = await createTestEvent();
    const client = await openClient(`ws://localhost:${cachePort}`);
    const ok = waitForMatch(client, (m) => m[0] === 'OK' && m[1] === event.id);
    client.send(JSON.stringify(['EVENT', event]));
    await ok;
    client.close();

    // The forwarded event becomes queryable on the upstream relay.
    const upstreamClient = await openClient(`ws://localhost:${upstreamPort}`);
    const received = waitForMatch(
      upstreamClient,
      (m) => m[0] === 'EVENT' && (m[2] as NostrEvent | undefined)?.id === event.id
    );
    upstreamClient.send(JSON.stringify(['REQ', 'check', { ids: [event.id] }]));
    const message = await received;
    expect((message[2] as NostrEvent).id).toBe(event.id);
    upstreamClient.close();
  });

  it('read-through: an upstream-only event is served through the cache', async () => {
    // Publish an event directly to the upstream relay only.
    const event = await createTestEvent();
    const publisher = await openClient(`ws://localhost:${upstreamPort}`);
    const ok = waitForMatch(publisher, (m) => m[0] === 'OK' && m[1] === event.id);
    publisher.send(JSON.stringify(['EVENT', event]));
    await ok;
    publisher.close();

    // A REQ to the cache relay returns it via read-through.
    const client = await openClient(`ws://localhost:${cachePort}`);
    const received = waitForMatch(
      client,
      (m) => m[0] === 'EVENT' && (m[2] as NostrEvent | undefined)?.id === event.id
    );
    client.send(JSON.stringify(['REQ', 'sub1', { ids: [event.id] }]));
    const message = await received;
    expect((message[2] as NostrEvent).id).toBe(event.id);
    client.close();
  });
});
