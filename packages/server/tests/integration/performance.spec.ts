/**
 * 同時接続・スループットの性能（負荷）テスト
 *
 * 多数の同時接続・多数のイベント投入・並行 REQ といった負荷の下でも、サーバーが
 * 正しく振る舞う（接続を取りこぼさない・全イベントを保存する・各購読に EOSE を返す）
 * ことを検証する。実行時間に依存した閾値アサーションは行わず、規定のテストタイムアウト内に
 * 全件を正しく処理できることをもって「スループットが破綻していない」ことを確認する。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { createTestEvent } from '../utils/test-events.js';

/**
 * サーバーへ接続し、open するまで待機した WebSocket を返す。
 */
async function connect(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    client.on('open', () => resolve());
    client.on('error', reject);
  });
  return client;
}

/**
 * 1 接続で複数イベントを送信し、全イベントの OK を受信するまで待機する。
 *
 * @returns 成功（success=true）として OK が返ったイベント ID の集合
 */
async function publishAll(
  client: WebSocket,
  events: NostrEvent[],
  timeoutMs = 15000
): Promise<Set<string>> {
  const expected = new Set(events.map((event) => event.id));
  const acked = new Set<string>();

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error(`Timed out: ${acked.size}/${expected.size} OK received`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'OK' && typeof message[1] === 'string' && expected.has(message[1])) {
        if (message[2] === true) {
          acked.add(message[1]);
        }
        if (acked.size === expected.size) {
          clearTimeout(timer);
          client.off('message', onMessage);
          resolve();
        }
      }
    };

    client.on('message', onMessage);
  });

  for (const event of events) {
    client.send(JSON.stringify(['EVENT', event]));
  }
  await done;
  return acked;
}

/**
 * REQ を送信し、EOSE を受信するまでに届いた EVENT 件数を返す。
 */
async function countReqEvents(
  client: WebSocket,
  subscriptionId: string,
  filter: unknown,
  timeoutMs = 15000
): Promise<number> {
  let received = 0;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('Timed out waiting for EOSE'));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'EVENT' && message[1] === subscriptionId) {
        received++;
      } else if (message[0] === 'EOSE' && message[1] === subscriptionId) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve();
      }
    };

    client.on('message', onMessage);
  });

  client.send(JSON.stringify(['REQ', subscriptionId, filter]));
  await done;
  return received;
}

describe('NostrRelayServer performance', () => {
  let server: NostrRelayServer;
  let port: number;

  beforeEach(async () => {
    port = Math.floor(Math.random() * 10000) + 40000;
    server = new NostrRelayServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should accept many simultaneous connections without losing any', async () => {
    const numClients = 30;
    const clients = await Promise.all(Array.from({ length: numClients }, () => connect(port)));

    // サーバーが全接続を登録するのを待つ
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.getConnectionCount()).toBe(numClients);

    // すべて切断し、接続数が 0 に戻ることを確認
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.on('close', () => resolve());
            client.close();
          })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.getConnectionCount()).toBe(0);
  }, 20000);

  it('should persist every event under a burst from a single client', async () => {
    const numEvents = 50;
    const events = await Promise.all(
      Array.from({ length: numEvents }, (_, i) =>
        createTestEvent(undefined, { content: `burst-${i}`, created_at: 1_000_000 + i })
      )
    );

    const client = await connect(port);
    const acked = await publishAll(client, events);
    client.close();

    expect(acked.size).toBe(numEvents);
    expect(await server.getEventCount()).toBe(numEvents);
  }, 20000);

  it('should persist events published concurrently from many clients', async () => {
    const numClients = 10;
    const eventsPerClient = 5;

    // クライアントごとに固有のイベント群を生成
    const perClientEvents = await Promise.all(
      Array.from({ length: numClients }, () =>
        Promise.all(
          Array.from({ length: eventsPerClient }, (_, i) =>
            createTestEvent(undefined, { content: `multi-${i}` })
          )
        )
      )
    );

    const clients = await Promise.all(Array.from({ length: numClients }, () => connect(port)));

    // 全クライアントから並行して投入
    await Promise.all(clients.map((client, idx) => publishAll(client, perClientEvents[idx])));

    for (const client of clients) {
      client.close();
    }

    const totalEvents = numClients * eventsPerClient;
    expect(await server.getEventCount()).toBe(totalEvents);
  }, 20000);

  it('should answer concurrent REQ subscriptions for all clients', async () => {
    // まず既知のイベントを保存
    const numStored = 20;
    const events = await Promise.all(
      Array.from({ length: numStored }, (_, i) =>
        createTestEvent(undefined, { content: `stored-${i}`, created_at: 2_000_000 + i })
      )
    );
    const publisher = await connect(port);
    await publishAll(publisher, events);
    publisher.close();

    expect(await server.getEventCount()).toBe(numStored);

    // 複数クライアントが同時に REQ を発行し、各々が全件 + EOSE を受け取ることを確認
    const numSubscribers = 10;
    const subscribers = await Promise.all(
      Array.from({ length: numSubscribers }, () => connect(port))
    );

    const counts = await Promise.all(
      subscribers.map((client, idx) => countReqEvents(client, `sub-${idx}`, { kinds: [1] }))
    );

    for (const client of subscribers) {
      client.close();
    }

    for (const count of counts) {
      expect(count).toBe(numStored);
    }
  }, 20000);
});
