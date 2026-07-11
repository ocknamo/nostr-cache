/**
 * Server persistence E2E test.
 *
 * Spawns the built relay server (`packages/server/dist/index.js`) as a real
 * child process with `NOSTR_DB_PATH` set, publishes an event, shuts the
 * process down with SIGINT, restarts it against the same database file, and
 * verifies the event survives the restart. This exercises the whole opt-in
 * persistence chain end to end: env var parsing in the entry point, the
 * SQLite storage adapter, and the conditional `clear()` skip on shutdown.
 * Requires `npm run build` beforehand.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../../src/spawn-server.js';
import { createTestEvent } from '../../src/test-events.js';
import { WsClient } from '../../src/ws-client.js';

describe('Server persistence E2E (NOSTR_DB_PATH)', () => {
  let server: RunningServer | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it('keeps published events across a SIGINT restart when NOSTR_DB_PATH is set', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nostr-e2e-persist-'));
    const dbPath = join(dataDir, 'relay.db');
    const event = await createTestEvent(undefined, { content: 'persisted across restart' });

    // 1st run: publish an event, then shut down cleanly via SIGINT.
    server = await startServer({ env: { NOSTR_DB_PATH: dbPath } });
    const publisher = await WsClient.connect(server.port);
    publisher.send(['EVENT', event]);
    const ok = await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);
    expect(ok[2]).toBe(true);
    publisher.close();

    const exitCode = await server.stop();
    expect(exitCode).toBe(0);

    // 2nd run against the same database file: the event must still be served.
    server = await startServer({ env: { NOSTR_DB_PATH: dbPath } });
    const subscriber = await WsClient.connect(server.port);
    subscriber.send(['REQ', 'persist-sub', { kinds: [1], authors: [event.pubkey] }]);

    const received = await subscriber.waitFor((m) => m[0] === 'EVENT' && m[1] === 'persist-sub');
    expect((received[2] as NostrEvent).id).toBe(event.id);
    expect((received[2] as NostrEvent).content).toBe('persisted across restart');

    await subscriber.waitFor((m) => m[0] === 'EOSE' && m[1] === 'persist-sub');
    subscriber.close();
  });

  it('stays non-persistent by default (no NOSTR_DB_PATH): events are gone after a restart', async () => {
    const event = await createTestEvent(undefined, { content: 'in-memory only' });

    // 1st run without NOSTR_DB_PATH: publish, then shut down.
    server = await startServer();
    const publisher = await WsClient.connect(server.port);
    publisher.send(['EVENT', event]);
    await publisher.waitFor((m) => m[0] === 'OK' && m[1] === event.id);
    publisher.close();
    await server.stop();

    // 2nd run: the default in-memory storage must start empty (EOSE without EVENT).
    server = await startServer();
    const subscriber = await WsClient.connect(server.port);
    subscriber.send(['REQ', 'memory-sub', { kinds: [1], authors: [event.pubkey] }]);

    await subscriber.waitFor((m) => m[0] === 'EOSE' && m[1] === 'memory-sub');
    await subscriber.expectNone((m) => m[0] === 'EVENT' && m[1] === 'memory-sub');
    subscriber.close();
  });
});
