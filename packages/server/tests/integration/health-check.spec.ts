/**
 * ヘルスチェックエンドポイントの統合テスト
 *
 * NostrRelayServer が公開する HTTP ヘルスチェックエンドポイント（既定 `/health`）が
 * リレーの稼働状況（接続数・イベント数）を返すこと、無効化や異常系で期待どおり振る舞うことを
 * 実際の HTTP リクエスト経由で検証する。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { reservePort, startRelayServer } from '../utils/free-port.js';
import { createTestEvent } from '../utils/test-events.js';

describe('NostrRelayServer health check endpoint', () => {
  let server: NostrRelayServer;
  let healthPort: number;

  beforeEach(async () => {
    // ヘルスチェックは動的ポート（0）で起動し、実際のバインドポートを取得する。
    // WebSocket 側は帯から 1 つ確保する（ヘルスチェックが +1 を使わないため 1 つでよい）。
    ({ server } = await startRelayServer(
      (p) => new NostrRelayServer({ port: p, healthCheck: { port: 0 } }),
      { portsPerRelay: 1 }
    ));

    const resolved = server.getHealthPort();
    if (resolved === null) {
      throw new Error('Health server failed to start');
    }
    healthPort = resolved;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should expose the actual bound health port', () => {
    expect(server.getHealthPort()).toBe(healthPort);
    expect(healthPort).toBeGreaterThan(0);
  });

  it('should default the health port to the WebSocket port + 1', async () => {
    // 既定（healthCheck.port 未指定）では WebSocket ポート + 1 にバインドされる。
    // 連番 2 つを確保して使う（この検証だけは番号そのものに意味がある）。
    const { server: defaultServer, port: wsPort } = await startRelayServer(
      (p) => new NostrRelayServer({ port: p })
    );
    try {
      expect(defaultServer.getPort()).toBe(wsPort);
      expect(defaultServer.getHealthPort()).toBe(wsPort + 1);
    } finally {
      await defaultServer.stop();
    }
  });

  it('should respond to GET /health with status ok and relay stats', async () => {
    const response = await fetch(`http://localhost:${healthPort}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as {
      status: string;
      uptime: number;
      connections: number;
      events: number;
    };

    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.connections).toBe(0);
    expect(body.events).toBe(0);
  });

  it('should reflect the active connection count', async () => {
    const wsPort = server.getPort();
    const client = new WebSocket(`ws://localhost:${wsPort}`);
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });
    // サーバーが接続を登録するのを待つ
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await fetch(`http://localhost:${healthPort}/health`);
    const body = (await response.json()) as { connections: number };
    expect(body.connections).toBe(1);

    client.close();
  });

  it('should reflect the stored event count', async () => {
    const wsPort = server.getPort();
    const client = new WebSocket(`ws://localhost:${wsPort}`);
    const event: NostrEvent = await createTestEvent();

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

    const response = await fetch(`http://localhost:${healthPort}/health`);
    const body = (await response.json()) as { events: number };
    expect(body.events).toBe(1);

    client.close();
  });

  it('should respond with 404 for an unknown path', async () => {
    const response = await fetch(`http://localhost:${healthPort}/unknown`);
    expect(response.status).toBe(404);
    // ボディを消費して接続を解放
    await response.text();
  });

  it('should respond with 404 for a non-GET method on /health', async () => {
    const response = await fetch(`http://localhost:${healthPort}/health`, {
      method: 'POST',
    });
    expect(response.status).toBe(404);
    await response.text();
  });
});

describe('NostrRelayServer health check disabled', () => {
  it('should not start the health endpoint when disabled', async () => {
    // ヘルスチェック用ポートは、サーバー起動まで掴んだままにするのが要点。
    // 先に解放してしまうと WebSocket 側に OS が同じ番号を割り当てうる
    // （fetch が通ってしまい偽陰性になる）。
    const reserved = await reservePort();
    const { server } = await startRelayServer(
      (p) =>
        new NostrRelayServer({ port: p, healthCheck: { enabled: false, port: reserved.port } }),
      { portsPerRelay: 1 }
    );
    await reserved.release();

    try {
      expect(server.getHealthPort()).toBeNull();
      expect(server.getPort()).not.toBe(reserved.port);

      // 無効化されているため接続は確立できない
      await expect(fetch(`http://localhost:${reserved.port}/health`)).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });
});
