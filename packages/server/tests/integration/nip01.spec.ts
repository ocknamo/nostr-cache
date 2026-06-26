/**
 * NIP-01 準拠の統合テスト拡充
 *
 * REQ のフィルタ適用 / CLOSE / エラーケース / サブスクリプション上限（レート制限）を
 * 実際の WebSocket 経由で検証する。`server.spec.ts` の基本フロー（接続・EVENT・REQ・CLOSE）を
 * 補完し、エッジケースの回帰を防ぐことを目的とする。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/nostr-relay-server.js';
import { getRandomSecret } from '../utils/get-random-secret.js';
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
 * 指定した述語に最初に一致したメッセージを待機する。
 *
 * @param client WebSocket クライアント
 * @param predicate メッセージ（パース済み配列）に対する一致条件
 * @param timeoutMs タイムアウト（ミリ秒）
 */
function waitForMessage(
  client: WebSocket,
  predicate: (message: unknown[]) => boolean,
  timeoutMs = 2000
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('Timed out waiting for matching message'));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (predicate(message)) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(message);
      }
    };

    client.on('message', onMessage);
  });
}

/**
 * REQ を送信し、EVENT を収集して EOSE を受信するまで待機する。
 * EOSE までに受け取った EVENT のイベント本体配列を返す。
 */
async function collectReqEvents(
  client: WebSocket,
  subscriptionId: string,
  filters: unknown[]
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('Timed out waiting for EOSE'));
    }, 2000);

    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'EVENT' && message[1] === subscriptionId) {
        events.push(message[2] as NostrEvent);
      } else if (message[0] === 'EOSE' && message[1] === subscriptionId) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve();
      }
    };

    client.on('message', onMessage);
  });

  client.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
  await done;
  return events;
}

/**
 * イベントを保存し、OK 応答を待機する。
 */
async function publishEvent(port: number, event: NostrEvent): Promise<void> {
  const client = await connect(port);
  const ok = waitForMessage(client, (message) => message[0] === 'OK' && message[1] === event.id);
  client.send(JSON.stringify(['EVENT', event]));
  await ok;
  client.close();
}

describe('NostrRelayServer NIP-01 compliance', () => {
  let server: NostrRelayServer;
  let port: number;

  beforeEach(async () => {
    port = Math.floor(Math.random() * 10000) + 9000;
    server = new NostrRelayServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('REQ filter handling', () => {
    it('should filter stored events by ids', async () => {
      const wanted = await createTestEvent();
      const other = await createTestEvent();
      await publishEvent(port, wanted);
      await publishEvent(port, other);

      const client = await connect(port);
      const events = await collectReqEvents(client, 'sub-ids', [{ ids: [wanted.id] }]);
      client.close();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(wanted.id);
    });

    it('should filter stored events by author', async () => {
      const seckey = getRandomSecret();
      const mine = await createTestEvent(seckey);
      const theirs = await createTestEvent();
      await publishEvent(port, mine);
      await publishEvent(port, theirs);

      const client = await connect(port);
      const events = await collectReqEvents(client, 'sub-author', [{ authors: [mine.pubkey] }]);
      client.close();

      expect(events).toHaveLength(1);
      expect(events[0].pubkey).toBe(mine.pubkey);
    });

    it('should filter stored events by single-letter (#p) tag', async () => {
      const target = await createTestEvent();
      // target の pubkey を p タグに持つイベントと、無関係なイベントを保存
      const tagged = await createTestEvent(undefined, {
        tags: [['p', target.pubkey]],
      });
      const untagged = await createTestEvent(undefined, { tags: [] });
      await publishEvent(port, tagged);
      await publishEvent(port, untagged);

      const client = await connect(port);
      const events = await collectReqEvents(client, 'sub-tag', [{ '#p': [target.pubkey] }]);
      client.close();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(tagged.id);
    });

    it('should respect the filter limit', async () => {
      // created_at を分散させて「3 件中 limit:2 で 2 件のみ返る」ことを確認する。
      // 返る 2 件の選択順序（最新優先）は実装依存のため、ここでは件数のみを検証する。
      const events = await Promise.all([
        createTestEvent(undefined, { created_at: 1_000 }),
        createTestEvent(undefined, { created_at: 2_000 }),
        createTestEvent(undefined, { created_at: 3_000 }),
      ]);
      for (const event of events) {
        await publishEvent(port, event);
      }

      const client = await connect(port);
      const received = await collectReqEvents(client, 'sub-limit', [{ kinds: [1], limit: 2 }]);
      client.close();

      expect(received).toHaveLength(2);
      // 返却されたイベントは保存済みイベントの部分集合であること
      const storedIds = new Set(events.map((event) => event.id));
      for (const event of received) {
        expect(storedIds.has(event.id)).toBe(true);
      }
    });

    it('should exclude events outside the since/until time range', async () => {
      const event = await createTestEvent(undefined, { created_at: 1_000_000 });
      await publishEvent(port, event);

      const client = await connect(port);
      const inRange = await collectReqEvents(client, 'sub-in', [
        { kinds: [1], since: 999_000, until: 1_001_000 },
      ]);
      const outOfRange = await collectReqEvents(client, 'sub-out', [
        { kinds: [1], since: 2_000_000 },
      ]);
      client.close();

      expect(inRange).toHaveLength(1);
      expect(outOfRange).toHaveLength(0);
    });

    it('should treat the since boundary as inclusive', async () => {
      // created_at と等しい since は境界を含む（NIP-01: since <= created_at）
      const event = await createTestEvent(undefined, { created_at: 1_500_000 });
      await publishEvent(port, event);

      const client = await connect(port);
      const atSince = await collectReqEvents(client, 'sub-since-eq', [
        { kinds: [1], since: 1_500_000 },
      ]);
      client.close();

      expect(atSince).toHaveLength(1);
    });

    it('should combine results from multiple overlapping filters without duplicates', async () => {
      // kinds:[1] は両イベントに一致し、ids:[shared.id] は片方に重複して一致する。
      // 重複排除が働けば 2 件（shared, another）が一意に返るはず。
      const shared = await createTestEvent(undefined, { kind: 1 });
      const another = await createTestEvent(undefined, { kind: 1 });
      await publishEvent(port, shared);
      await publishEvent(port, another);

      const client = await connect(port);
      const events = await collectReqEvents(client, 'sub-multi', [
        { kinds: [1] },
        { ids: [shared.id] },
      ]);
      client.close();

      const ids = events.map((event) => event.id);
      const uniqueIds = new Set(ids);
      // 重複が無いこと（配列長 === ユニーク数）
      expect(ids).toHaveLength(uniqueIds.size);
      expect([...uniqueIds].sort()).toEqual([shared.id, another.id].sort());
    });

    it('should only return the latest replaceable event (kind 0)', async () => {
      const seckey = getRandomSecret();
      const older = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1_000,
        content: 'old profile',
      });
      const newer = await createTestEvent(seckey, {
        kind: 0,
        created_at: 2_000,
        content: 'new profile',
      });
      await publishEvent(port, older);
      await publishEvent(port, newer);

      expect(await server.getEventCount()).toBe(1);

      const client = await connect(port);
      const events = await collectReqEvents(client, 'sub-replaceable', [
        { kinds: [0], authors: [newer.pubkey] },
      ]);
      client.close();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(newer.id);
      expect(events[0].content).toBe('new profile');
    });
  });

  describe('error handling', () => {
    it('should respond with NOTICE for a non-array message', async () => {
      const client = await connect(port);
      const notice = waitForMessage(client, (message) => message[0] === 'NOTICE');
      client.send(JSON.stringify({ not: 'an array' }));

      const message = await notice;
      expect(message[0]).toBe('NOTICE');
      expect(message[1]).toBe('Invalid message format');
      client.close();
    });

    it('should respond with NOTICE for an unknown message type', async () => {
      const client = await connect(port);
      const notice = waitForMessage(client, (message) => message[0] === 'NOTICE');
      client.send(JSON.stringify(['FOO', 'bar']));

      const message = await notice;
      expect(message[1]).toContain('Unknown message type');
      client.close();
    });

    it('should respond with NOTICE when REQ has no filters', async () => {
      const client = await connect(port);
      const notice = waitForMessage(client, (message) => message[0] === 'NOTICE');
      client.send(JSON.stringify(['REQ', 'sub-empty']));

      const message = await notice;
      expect(message[1]).toContain('filters must be a non-empty array');
      client.close();
    });

    it('should respond with NOTICE for an invalid filter', async () => {
      const client = await connect(port);
      const notice = waitForMessage(client, (message) => message[0] === 'NOTICE');
      // 有効な条件を一つも持たない空フィルタは拒否される
      client.send(JSON.stringify(['REQ', 'sub-bad', {}]));

      const message = await notice;
      expect(message[1]).toContain('Invalid filter format');
      client.close();
    });

    it('should reject an event with an invalid signature', async () => {
      const event = await createTestEvent();
      // 署名後に content を改ざんし、署名検証を失敗させる
      const tampered: NostrEvent = { ...event, content: 'tampered content' };

      const client = await connect(port);
      const ok = waitForMessage(
        client,
        (message) => message[0] === 'OK' && message[1] === tampered.id
      );
      client.send(JSON.stringify(['EVENT', tampered]));

      const message = await ok;
      expect(message[2]).toBe(false);
      expect(String(message[3])).toContain('invalid');
      client.close();
    });
  });

  describe('CLOSE handling', () => {
    it('should acknowledge CLOSE for an unknown subscription', async () => {
      const client = await connect(port);
      const closed = waitForMessage(
        client,
        (message) => message[0] === 'CLOSED' && message[1] === 'never-opened'
      );
      client.send(JSON.stringify(['CLOSE', 'never-opened']));

      const message = await closed;
      expect(message[0]).toBe('CLOSED');
      expect(message[1]).toBe('never-opened');
      client.close();
    });

    it('should stop delivering live events after CLOSE', async () => {
      const client = await connect(port);

      // 購読を作成し EOSE まで待機
      await collectReqEvents(client, 'live', [{ kinds: [1] }]);

      // 購読をクローズ
      const closed = waitForMessage(
        client,
        (message) => message[0] === 'CLOSED' && message[1] === 'live'
      );
      client.send(JSON.stringify(['CLOSE', 'live']));
      await closed;

      // クローズ後に到着したイベントが配信されないことを確認
      let receivedAfterClose = false;
      const onMessage = (data: WebSocket.RawData): void => {
        const message = JSON.parse(data.toString()) as unknown[];
        if (message[0] === 'EVENT' && message[1] === 'live') {
          receivedAfterClose = true;
        }
      };
      client.on('message', onMessage);

      const event = await createTestEvent();
      await publishEvent(port, event);
      await new Promise((resolve) => setTimeout(resolve, 100));

      client.off('message', onMessage);
      client.close();

      expect(receivedAfterClose).toBe(false);
    });
  });

  describe('subscription limit (rate limiting)', () => {
    it('should reject subscriptions beyond the configured maximum', async () => {
      const limitedPort = Math.floor(Math.random() * 10000) + 20000;
      const limitedServer = new NostrRelayServer({
        port: limitedPort,
        relay: { maxSubscriptions: 2 },
      });
      await limitedServer.start();

      try {
        const client = await connect(limitedPort);

        await collectReqEvents(client, 'sub-1', [{ kinds: [1] }]);
        await collectReqEvents(client, 'sub-2', [{ kinds: [1] }]);

        // 3 つ目の購読は上限を超えるため NOTICE で拒否される
        const notice = waitForMessage(client, (message) => message[0] === 'NOTICE');
        client.send(JSON.stringify(['REQ', 'sub-3', { kinds: [1] }]));

        const message = await notice;
        expect(message[1]).toContain('Subscription limit reached');
        client.close();
      } finally {
        await limitedServer.stop();
      }
    });
  });
});
