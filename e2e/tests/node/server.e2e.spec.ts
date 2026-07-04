/**
 * Node.js client-server E2E test.
 *
 * Spawns the built relay server (`packages/server/dist/index.js`) as a real
 * child process and drives it with real WebSocket clients through the full
 * NIP-01 message flow. Requires `npm run build` beforehand.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../../src/spawn-server.js';
import { createTestEvent } from '../../src/test-events.js';
import { WsClient } from '../../src/ws-client.js';

describe('Node.js client-server E2E', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('starts as a child process and accepts a WebSocket connection', async () => {
    const client = await WsClient.connect(server.port);
    expect(server.port).toBeGreaterThan(0);
    client.close();
  });

  it('accepts a signed EVENT and responds with OK true', async () => {
    const client = await WsClient.connect(server.port);
    const event = await createTestEvent();

    client.send(['EVENT', event]);
    const ok = await client.waitFor((m) => m[0] === 'OK' && m[1] === event.id);

    expect(ok[2]).toBe(true);
    client.close();
  });

  it('rejects a tampered EVENT with OK false', async () => {
    const client = await WsClient.connect(server.port);
    const event = await createTestEvent();
    // Corrupt the content after signing so the signature no longer matches.
    const tampered: NostrEvent = { ...event, content: 'tampered content' };

    client.send(['EVENT', tampered]);
    const ok = await client.waitFor((m) => m[0] === 'OK' && m[1] === tampered.id);

    expect(ok[2]).toBe(false);
    client.close();
  });

  it('returns stored events then EOSE for a REQ', async () => {
    const publisher = await WsClient.connect(server.port);
    const event = await createTestEvent();

    publisher.send(['EVENT', event]);
    await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);
    publisher.close();

    const subscriber = await WsClient.connect(server.port);
    subscriber.send(['REQ', 'stored-sub', { kinds: [1], authors: [event.pubkey] }]);

    const received = await subscriber.waitFor((m) => m[0] === 'EVENT' && m[1] === 'stored-sub');
    expect((received[2] as NostrEvent).id).toBe(event.id);

    const eose = await subscriber.waitFor((m) => m[0] === 'EOSE' && m[1] === 'stored-sub');
    expect(eose[0]).toBe('EOSE');

    // The stored EVENT must arrive before EOSE.
    expect(received[0]).toBe('EVENT');
    subscriber.close();
  });

  it('broadcasts a live event to an active subscription', async () => {
    const subscriber = await WsClient.connect(server.port);
    const publisher = await WsClient.connect(server.port);
    const event = await createTestEvent(undefined, { content: 'live broadcast' });

    // Establish the subscription first and wait for EOSE.
    subscriber.send(['REQ', 'live-sub', { kinds: [1], authors: [event.pubkey] }]);
    await subscriber.waitFor((m) => m[0] === 'EOSE' && m[1] === 'live-sub');

    // A different client publishes a matching event.
    publisher.send(['EVENT', event]);
    await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);

    const live = await subscriber.waitFor(
      (m) => m[0] === 'EVENT' && m[1] === 'live-sub' && (m[2] as NostrEvent).id === event.id
    );
    expect((live[2] as NostrEvent).content).toBe('live broadcast');

    subscriber.close();
    publisher.close();
  });

  it('stops delivering to a subscription after CLOSE', async () => {
    const subscriber = await WsClient.connect(server.port);
    const publisher = await WsClient.connect(server.port);
    const event = await createTestEvent(undefined, { content: 'after close' });

    subscriber.send(['REQ', 'close-sub', { kinds: [1], authors: [event.pubkey] }]);
    await subscriber.waitFor((m) => m[0] === 'EOSE' && m[1] === 'close-sub');

    subscriber.send(['CLOSE', 'close-sub']);
    const closed = await subscriber.waitFor((m) => m[0] === 'CLOSED' && m[1] === 'close-sub');
    expect(closed[0]).toBe('CLOSED');

    publisher.send(['EVENT', event]);
    await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);

    // No live EVENT should reach the closed subscription.
    await subscriber.expectNone((m) => m[0] === 'EVENT' && m[1] === 'close-sub');

    subscriber.close();
    publisher.close();
  });

  it('broadcasts to multiple simultaneous subscribers', async () => {
    const subscribers = await Promise.all([
      WsClient.connect(server.port),
      WsClient.connect(server.port),
      WsClient.connect(server.port),
    ]);
    const publisher = await WsClient.connect(server.port);
    const event = await createTestEvent(undefined, { content: 'fan out' });

    await Promise.all(
      subscribers.map(async (client, index) => {
        const subId = `multi-${index}`;
        client.send(['REQ', subId, { kinds: [1], authors: [event.pubkey] }]);
        await client.waitFor((m) => m[0] === 'EOSE' && m[1] === subId);
      })
    );

    publisher.send(['EVENT', event]);
    await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);

    await Promise.all(
      subscribers.map(async (client, index) => {
        const subId = `multi-${index}`;
        const live = await client.waitFor(
          (m) => m[0] === 'EVENT' && m[1] === subId && (m[2] as NostrEvent).id === event.id
        );
        expect((live[2] as NostrEvent).id).toBe(event.id);
      })
    );

    for (const client of subscribers) client.close();
    publisher.close();
  });

  it('shuts down cleanly on SIGINT', async () => {
    const ownServer = await startServer();
    const client = await WsClient.connect(ownServer.port);
    client.close();

    const exitCode = await ownServer.stop();
    expect(exitCode).toBe(0);
  });
});
