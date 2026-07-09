/**
 * Unit tests for HealthServer
 *
 * integration の health-check.spec.ts が NostrRelayServer 経由で 200 / 404 /
 * 無効化 / 動的ポートを検証しているのに対し、ここでは HealthServer 単体を
 * 直接テストする。特に snapshot コールバックが失敗したときの 500 分岐は
 * integration 側では作り出せないため、ここでのみ検証される。
 */

import { type HealthCheckResponse, HealthServer } from './health-server.js';

const okSnapshot = async (): Promise<HealthCheckResponse> => ({
  status: 'ok',
  uptime: 1,
  connections: 0,
  events: 0,
});

describe('HealthServer', () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('serves the snapshot as JSON on the health path', async () => {
    server = new HealthServer({ port: 0 }, 8008, undefined, okSnapshot);
    await server.start();

    const port = server.getBoundPort();
    expect(port).not.toBeNull();

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      uptime: 1,
      connections: 0,
      events: 0,
    });
  });

  it('responds with 500 when the snapshot callback rejects', async () => {
    server = new HealthServer({ port: 0 }, 8008, undefined, async () => {
      throw new Error('storage unavailable');
    });
    await server.start();

    const response = await fetch(`http://localhost:${server.getBoundPort()}/health`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error' });
  });

  it('responds with 404 off the health path and for non-GET methods', async () => {
    server = new HealthServer({ port: 0 }, 8008, undefined, okSnapshot);
    await server.start();
    const port = server.getBoundPort();

    const wrongPath = await fetch(`http://localhost:${port}/nope`);
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await fetch(`http://localhost:${port}/health`, { method: 'POST' });
    expect(wrongMethod.status).toBe(404);
  });

  it('does not listen when disabled', async () => {
    server = new HealthServer({ enabled: false, port: 0 }, 8008, undefined, okSnapshot);
    await server.start();

    expect(server.getBoundPort()).toBeNull();
  });
});
