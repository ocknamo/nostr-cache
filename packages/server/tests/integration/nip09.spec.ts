/**
 * NIP-09（イベント削除リクエスト・kind 5）の統合テスト
 *
 * 実際の WebSocket 経由で、削除リクエストが参照先イベントを消すこと、
 * 他者のイベントや削除リクエスト自身は消せないこと、リクエスト自体は
 * 保存され配信され続けることを検証する。署名は実鍵で生成するため、
 * 「同一 pubkey のイベントのみ削除可」の制約を実際の署名込みで確認できる。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { getRandomSecret } from '@nostr-cache/shared';
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
 * 指定した述語に最初に一致したメッセージを待機する。
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
 * REQ を送信し、EOSE までに受け取った EVENT を返す。
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
async function publishEvent(port: number, event: NostrEvent): Promise<unknown[]> {
  const client = await connect(port);
  const ok = waitForMessage(client, (message) => message[0] === 'OK' && message[1] === event.id);
  client.send(JSON.stringify(['EVENT', event]));
  const response = await ok;
  client.close();
  return response;
}

/**
 * 保存済みイベントの id 一覧を取得する（フィルタ指定）。
 */
async function storedIds(port: number, filters: unknown[]): Promise<string[]> {
  const client = await connect(port);
  const events = await collectReqEvents(client, `sub-${Math.random()}`, filters);
  client.close();
  return events.map((event) => event.id).sort();
}

describe('NostrRelayServer NIP-09 event deletion', () => {
  let server: NostrRelayServer;
  let port: number;

  beforeEach(async () => {
    // ポート帯は spec ファイルごとに分けている（並列実行時の衝突回避）
    port = Math.floor(Math.random() * 10000) + 50000;
    server = new NostrRelayServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('e tag references', () => {
    it('should delete the author’s own referenced event', async () => {
      const seckey = getRandomSecret();
      const target = await createTestEvent(seckey, { content: 'to be deleted' });
      const kept = await createTestEvent(seckey, { content: 'to be kept' });
      await publishEvent(port, target);
      await publishEvent(port, kept);

      const deletion = await createTestEvent(seckey, {
        kind: 5,
        tags: [
          ['e', target.id],
          ['k', '1'],
        ],
        content: 'published by accident',
      });
      await publishEvent(port, deletion);

      expect(await storedIds(port, [{ kinds: [1] }])).toEqual([kept.id]);
    });

    it('should not delete another author’s event', async () => {
      const victim = await createTestEvent(getRandomSecret(), { content: 'not yours' });
      await publishEvent(port, victim);

      // 別の鍵で victim.id を指す削除リクエストを送る
      const deletion = await createTestEvent(getRandomSecret(), {
        kind: 5,
        tags: [['e', victim.id]],
      });
      const ok = await publishEvent(port, deletion);

      // リクエスト自体は受理されるが、他者のイベントは削除されない
      expect(ok[2]).toBe(true);
      expect(await storedIds(port, [{ kinds: [1] }])).toEqual([victim.id]);
    });

    it('should keep serving the deletion request itself', async () => {
      const seckey = getRandomSecret();
      const target = await createTestEvent(seckey);
      await publishEvent(port, target);

      const deletion = await createTestEvent(seckey, {
        kind: 5,
        tags: [['e', target.id]],
      });
      await publishEvent(port, deletion);

      // クライアントがまだ削除を知らない可能性があるため、リクエストは配信し続ける
      expect(await storedIds(port, [{ kinds: [5] }])).toEqual([deletion.id]);
    });

    it('should have no effect when targeting another deletion request', async () => {
      const seckey = getRandomSecret();
      const target = await createTestEvent(seckey);
      await publishEvent(port, target);

      const firstDeletion = await createTestEvent(seckey, {
        kind: 5,
        tags: [['e', target.id]],
        created_at: 1234567891,
      });
      await publishEvent(port, firstDeletion);

      const undoAttempt = await createTestEvent(seckey, {
        kind: 5,
        tags: [['e', firstDeletion.id]],
        created_at: 1234567892,
      });
      await publishEvent(port, undoAttempt);

      // 削除リクエストに対する削除リクエストは効果を持たない（両方残る）
      expect(await storedIds(port, [{ kinds: [5] }])).toEqual(
        [firstDeletion.id, undoAttempt.id].sort()
      );
    });

    it('should deliver the deletion request to live subscribers', async () => {
      const seckey = getRandomSecret();
      const subscriber = await connect(port);
      const received = waitForMessage(
        subscriber,
        (message) => message[0] === 'EVENT' && message[1] === 'sub-live'
      );
      subscriber.send(JSON.stringify(['REQ', 'sub-live', { kinds: [5] }]));
      await waitForMessage(subscriber, (message) => message[0] === 'EOSE');

      const deletion = await createTestEvent(seckey, {
        kind: 5,
        tags: [['e', 'f'.repeat(64)]],
      });
      await publishEvent(port, deletion);

      const message = await received;
      subscriber.close();

      expect((message[2] as NostrEvent).id).toBe(deletion.id);
    });
  });

  describe('a tag references', () => {
    it('should delete addressable versions up to the request created_at', async () => {
      const seckey = getRandomSecret();
      const older = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 1000,
        tags: [['d', 'my-article']],
      });
      const newer = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 3000,
        tags: [['d', 'my-article']],
      });
      // addressable は同一座標だと置換されるため、別座標として両方を保存しておき
      // created_at の境界だけを見る
      const otherSlug = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 1000,
        tags: [['d', 'other-article']],
      });
      await publishEvent(port, older);
      await publishEvent(port, otherSlug);
      await publishEvent(port, newer);

      const deletion = await createTestEvent(seckey, {
        kind: 5,
        created_at: 2000,
        tags: [
          ['a', `30023:${older.pubkey}:my-article`],
          ['k', '30023'],
        ],
      });
      await publishEvent(port, deletion);

      // created_at <= 2000 の 'my-article' のみ削除。リクエスト後の版と別 slug は残る
      expect(await storedIds(port, [{ kinds: [30023] }])).toEqual([newer.id, otherSlug.id].sort());
    });

    it('should delete a replaceable event addressed without an identifier', async () => {
      const seckey = getRandomSecret();
      const profile = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1000,
        tags: [],
        content: '{"name":"alice"}',
      });
      await publishEvent(port, profile);

      const deletion = await createTestEvent(seckey, {
        kind: 5,
        created_at: 2000,
        tags: [['a', `0:${profile.pubkey}:`]],
      });
      await publishEvent(port, deletion);

      expect(await storedIds(port, [{ kinds: [0] }])).toEqual([]);
    });

    it('should ignore an a tag naming another author', async () => {
      const victimKey = getRandomSecret();
      const article = await createTestEvent(victimKey, {
        kind: 30023,
        created_at: 1000,
        tags: [['d', 'my-article']],
      });
      await publishEvent(port, article);

      const deletion = await createTestEvent(getRandomSecret(), {
        kind: 5,
        created_at: 2000,
        tags: [['a', `30023:${article.pubkey}:my-article`]],
      });
      await publishEvent(port, deletion);

      expect(await storedIds(port, [{ kinds: [30023] }])).toEqual([article.id]);
    });

    it('should ignore an a tag naming a regular kind', async () => {
      const seckey = getRandomSecret();
      const note = await createTestEvent(seckey, { created_at: 1000 });
      await publishEvent(port, note);

      // `1:<pubkey>:` を受理すると「この著者の kind 1 を全部削除」になってしまう
      const deletion = await createTestEvent(seckey, {
        kind: 5,
        created_at: 2000,
        tags: [['a', `1:${note.pubkey}:`]],
      });
      await publishEvent(port, deletion);

      expect(await storedIds(port, [{ kinds: [1] }])).toEqual([note.id]);
    });
  });
});
