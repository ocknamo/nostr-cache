/**
 * NostrRelayServer統合テスト
 */

import type { NostrEvent } from '@nostr-cache/types';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/index.js';
import { createTestEvent } from '../utils/testEvents.js';

describe('NostrRelayServer', () => {
  let server: NostrRelayServer;
  let port: number;

  beforeEach(async () => {
    // ランダムなポートでサーバーを起動
    port = Math.floor(Math.random() * 10000) + 9000;
    server = new NostrRelayServer({ port });
    await server.start();
  });

  afterEach(async () => {
    // テスト後にサーバーを停止
    await server.stop();
  });

  it('should accept WebSocket connections', async () => {
    // WebSocket接続が確立できることを確認
    const client = new WebSocket(`ws://localhost:${port}`);

    await new Promise<void>((resolve) => {
      client.on('open', () => {
        expect(client.readyState).toBe(WebSocket.OPEN);
        resolve();
      });
    });

    client.close();
  });

  it('should handle EVENT messages and respond with OK', async () => {
    // EVENTメッセージを処理し、OKレスポンスを返すことを確認
    const client = new WebSocket(`ws://localhost:${port}`);
    const event = await createTestEvent();

    // 接続待機
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    // OK応答待機
    const responsePromise = new Promise<string[]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'OK' && message[1] === event.id) {
          resolve(message);
        }
      });
    });

    // イベント送信
    client.send(JSON.stringify(['EVENT', event]));

    // レスポンス検証
    const response = await responsePromise;
    expect(response[0]).toBe('OK');
    expect(response[1]).toBe(event.id);
    expect(response[2]).toBe(true);

    client.close();
  });

  it('should handle REQ messages and return matching events', async () => {
    // REQメッセージを処理し、該当するイベントを返すことを確認
    const client = new WebSocket(`ws://localhost:${port}`);
    const event = await createTestEvent();

    // 接続待機
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    // 先にイベントを保存
    const publishClient = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      publishClient.on('open', resolve);
    });

    // イベント送信と保存の確認
    const publishResponsePromise = new Promise<string[]>((resolve) => {
      publishClient.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'OK' && message[1] === event.id) {
          resolve(message);
        }
      });
    });
    publishClient.send(JSON.stringify(['EVENT', event]));
    await publishResponsePromise;
    publishClient.close();

    // イベント受信待機
    const eventPromise = new Promise<[string, string, NostrEvent]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'EVENT' && message[1] === 'sub1') {
          resolve(message);
        }
      });
    });

    // EOSE受信待機
    const eosePromise = new Promise<string[]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'EOSE' && message[1] === 'sub1') {
          resolve(message);
        }
      });
    });

    // サブスクリプション作成
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [event.pubkey] }]));

    // 結果検証
    const receivedEvent = await eventPromise;
    expect(receivedEvent[0]).toBe('EVENT');
    expect(receivedEvent[1]).toBe('sub1');
    expect(receivedEvent[2].id).toBe(event.id);

    // EOSEも受信することを確認
    const eose = await eosePromise;
    expect(eose[0]).toBe('EOSE');
    expect(eose[1]).toBe('sub1');

    client.close();
  });

  it('should handle CLOSE messages', async () => {
    // CLOSEメッセージを処理することを確認
    const client = new WebSocket(`ws://localhost:${port}`);

    // 接続待機
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    // CLOSEDメッセージ待機
    const closedPromise = new Promise<string[]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'CLOSED' && message[1] === 'sub1') {
          resolve(message);
        }
      });
    });

    // サブスクリプション作成
    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]));

    // 少し待機してからサブスクリプションを終了
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.send(JSON.stringify(['CLOSE', 'sub1']));

    // CLOSEDメッセージを受信することを確認
    const closed = await closedPromise;
    expect(closed[0]).toBe('CLOSED');
    expect(closed[1]).toBe('sub1');

    client.close();
  });

  it('should handle multiple connections simultaneously', async () => {
    // 複数の接続を同時に処理できることを確認
    const numClients = 5;
    const clients: WebSocket[] = [];

    // 複数クライアント作成
    for (let i = 0; i < numClients; i++) {
      const client = new WebSocket(`ws://localhost:${port}`);
      clients.push(client);
    }

    // 全クライアントの接続完了を待機
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.on('open', () => {
              expect(client.readyState).toBe(WebSocket.OPEN);
              resolve();
            });
          })
      )
    );

    // クライアントを閉じる
    for (const client of clients) {
      client.close();
    }
  });
});
