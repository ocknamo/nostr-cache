import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { startRelayServer } from '../utils/free-port.js';
import { createTestEvent } from '../utils/test-events.js';

describe('NostrRelayServer', () => {
  let server: NostrRelayServer;
  let port: number;

  beforeEach(async () => {
    // ワーカー専用帯から確保し、埋まっていれば別の枠で自動リトライして起動する
    ({ server, port } = await startRelayServer((p) => new NostrRelayServer({ port: p })));
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

    await new Promise<void>((resolve) => {
      client.on('open', () => {
        resolve();
      });
    });

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

    const eosePromise = new Promise<string[]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'EOSE' && message[1] === 'sub1') {
          resolve(message);
        }
      });
    });

    client.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], authors: [event.pubkey] }]));

    // 結果検証
    const receivedEvent = await eventPromise;
    expect(receivedEvent[0]).toBe('EVENT');
    expect(receivedEvent[1]).toBe('sub1');
    expect(receivedEvent[2].id).toBe(event.id);

    const eose = await eosePromise;
    expect(eose[0]).toBe('EOSE');
    expect(eose[1]).toBe('sub1');

    client.close();
  });

  it('should handle CLOSE messages', async () => {
    // CLOSEメッセージを処理することを確認
    const client = new WebSocket(`ws://localhost:${port}`);

    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    const closedPromise = new Promise<string[]>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'CLOSED' && message[1] === 'sub1') {
          resolve(message);
        }
      });
    });

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

  it('should report the active connection count', async () => {
    expect(server.getConnectionCount()).toBe(0);

    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    // Allow the server to register the connection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.getConnectionCount()).toBe(1);

    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.close();
    });

    // Allow the server to register the disconnection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.getConnectionCount()).toBe(0);
  });

  it('should report the stored event count', async () => {
    expect(await server.getEventCount()).toBe(0);

    const client = new WebSocket(`ws://localhost:${port}`);
    const event = await createTestEvent();

    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    const okPromise = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'OK' && message[1] === event.id) {
          resolve();
        }
      });
    });

    client.send(JSON.stringify(['EVENT', event]));
    await okPromise;

    expect(await server.getEventCount()).toBe(1);

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

describe('NostrRelayServer cachePriority option', () => {
  it('should throw at construction time on an invalid cachePriority pubkey', () => {
    expect(
      () =>
        new NostrRelayServer({
          port: 9999,
          storageOptions: { cachePriority: { pubkeys: ['npub1invalid'] } },
        })
    ).toThrow(/npub1invalid/);
  });

  it('should accept npub pubkeys and kinds in storageOptions.cachePriority', () => {
    // NIP-19 公式テストベクタの npub が正規化を通ること（例外を投げない）
    const server = new NostrRelayServer({
      port: 9999,
      storageOptions: {
        cachePriority: {
          pubkeys: ['npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'],
          kinds: [0],
        },
      },
    });
    expect(server).toBeDefined();
  });

  it('should allow replacing the priority config at runtime via setCachePriority', () => {
    const server = new NostrRelayServer({ port: 9999 });
    // 委譲先の relay まで届くことを検証する（private フィールドへのスパイ）
    // biome-ignore lint/suspicious/noExplicitAny: テストのため private relay にアクセス
    const relaySpy = vi.spyOn((server as any).relay, 'setCachePriority');

    // npub / hex を受け付け、不正値は例外（現行設定は維持される）
    const input = {
      pubkeys: ['npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'],
      kinds: [0],
    };
    server.setCachePriority(input);
    expect(relaySpy).toHaveBeenCalledWith(input);

    expect(() => server.setCachePriority({ pubkeys: ['npub1invalid'] })).toThrow(/npub1invalid/);

    server.setCachePriority(undefined);
    expect(relaySpy).toHaveBeenLastCalledWith(undefined);
  });
});
