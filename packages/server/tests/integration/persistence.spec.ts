/**
 * Opt-in persistence integration test.
 *
 * `storageOptions.dbPath` を指定した NostrRelayServer が、stop() をまたいで
 * イベントを保持すること（＝ stop() がストレージをクリアしないこと）と、
 * dbPath 未指定の既定モードが従来どおり stop() でクリアされることを、
 * 実 WebSocket 経由で検証する。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { createTestEvent } from '../utils/test-events.js';

/** Connect and resolve once the socket is open. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://localhost:${port}`);
    client.on('open', () => resolve(client));
    client.on('error', reject);
  });
}

/** Wait for the first message matching the predicate. */
function waitFor(client: WebSocket, predicate: (m: unknown[]) => boolean): Promise<unknown[]> {
  return new Promise((resolve) => {
    client.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (predicate(message)) {
        resolve(message);
      }
    });
  });
}

/** Publish an event and wait for its OK response. */
async function publish(port: number, event: NostrEvent): Promise<void> {
  const client = await connect(port);
  const ok = waitFor(client, (m) => m[0] === 'OK' && m[1] === event.id);
  client.send(JSON.stringify(['EVENT', event]));
  await ok;
  client.close();
}

describe('NostrRelayServer persistence (storageOptions.dbPath)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nostr-persist-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const randomPort = () => Math.floor(Math.random() * 10000) + 9000;

  it('keeps events across stop/restart when dbPath is set', async () => {
    const dbPath = join(dataDir, 'relay.db');
    const event = await createTestEvent();

    // 1st server: publish, then stop (must NOT clear the persistent storage)
    const first = new NostrRelayServer({ port: randomPort(), storageOptions: { dbPath } });
    await first.start();
    await publish(first.getPort(), event);
    expect(await first.getEventCount()).toBe(1);
    await first.stop();

    // 2nd server on the same database file: the event must still be there
    const second = new NostrRelayServer({ port: randomPort(), storageOptions: { dbPath } });
    await second.start();
    try {
      expect(await second.getEventCount()).toBe(1);

      const client = await connect(second.getPort());
      const received = waitFor(client, (m) => m[0] === 'EVENT' && m[1] === 'persist-sub');
      const eose = waitFor(client, (m) => m[0] === 'EOSE' && m[1] === 'persist-sub');
      client.send(JSON.stringify(['REQ', 'persist-sub', { authors: [event.pubkey] }]));

      const message = await received;
      expect((message[2] as NostrEvent).id).toBe(event.id);
      await eose;
      client.close();
    } finally {
      await second.stop();
    }
  });

  it('supports stop/start on the same instance in persistent mode', async () => {
    const dbPath = join(dataDir, 'relay.db');
    const event = await createTestEvent();

    // 同一インスタンスの stop() → start() でも、閉じた DB が再オープンされ
    // データが保持されていること（既定モードとの lifecycle 対称性）
    const server = new NostrRelayServer({ port: randomPort(), storageOptions: { dbPath } });
    await server.start();
    await publish(server.getPort(), event);
    await server.stop();

    await server.start();
    try {
      expect(await server.getEventCount()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('clears events on stop in the default in-memory mode', async () => {
    const event = await createTestEvent();

    const server = new NostrRelayServer({ port: randomPort() });
    await server.start();
    await publish(server.getPort(), event);
    expect(await server.getEventCount()).toBe(1);
    await server.stop();

    // 既定モードの stop() は従来どおりストレージをクリアする
    expect(await server.getEventCount()).toBe(0);
  });
});
