import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeWebSocket, createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { IndexRelayClient } from './index-relay-client.js';

const A = 'wss://a.example.com';
const B = 'wss://b.example.com';

function makeEvent(id: string): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind: 10002, tags: [], content: '', sig: '' };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** rx-nostr が REQ を送るまで待ち、そのワイヤ上の購読 id を返す。 */
async function reqId(socket: FakeWebSocket): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const req = socket.sent.find((message) => Array.isArray(message) && message[0] === 'REQ');
    if (req) {
      return (req as string[])[1];
    }
    await flush();
  }
  throw new Error(`no REQ sent to ${socket.url}`);
}

const clients: IndexRelayClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
});

function createClient(eoseTimeout = 5000) {
  const fake = createFakeWebSocketFactory();
  const client = new IndexRelayClient([A, B], { webSocketFactory: fake.factory, eoseTimeout });
  clients.push(client);
  return { client, fake };
}

describe('IndexRelayClient', () => {
  it('returns every relay’s answer once all of them have sent EOSE', async () => {
    const { client, fake } = createClient();

    const result = client.fetch({ kinds: [10002], authors: ['p'] });
    await flush();
    for (const socket of fake.sockets) {
      socket.mockOpen();
    }
    const a = fake.forUrl(A) as FakeWebSocket;
    const b = fake.forUrl(B) as FakeWebSocket;
    const idA = await reqId(a);
    const idB = await reqId(b);
    a.mockMessage(['EVENT', idA, makeEvent('x')]);
    b.mockMessage(['EVENT', idB, makeEvent('x')]);
    b.mockMessage(['EVENT', idB, makeEvent('y')]);
    a.mockMessage(['EOSE', idA]);
    b.mockMessage(['EOSE', idB]);

    // 同じ id を重複排除しない（版の選別は取り込み側が持つ）
    expect((await result).map((event) => event.id).sort()).toEqual(['x', 'x', 'y']);
  });

  it('gives up on a relay that never answers', async () => {
    const { client, fake } = createClient(30);

    const result = client.fetch({ kinds: [10002], authors: ['p'] });
    await flush();
    const a = fake.forUrl(A) as FakeWebSocket;
    a.mockOpen();
    const idA = await reqId(a);
    a.mockMessage(['EVENT', idA, makeEvent('x')]);
    a.mockMessage(['EOSE', idA]);

    expect((await result).map((event) => event.id)).toEqual(['x']);
  });

  it('answers empty without connecting once stopped', async () => {
    const { client, fake } = createClient();
    client.stop();

    expect(await client.fetch({ kinds: [10002] })).toEqual([]);
    expect(fake.sockets).toHaveLength(0);
  });
});
