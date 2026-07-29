/**
 * A minimal NIP-01 relay used as a stand-in upstream.
 *
 * The embed widget's read-through path needs a real upstream to fetch from, and
 * a canned one makes the assertions deterministic: the test knows exactly which
 * events should arrive, so it can tell an upstream fetch from a cache hit.
 *
 * Only what the widget exercises is implemented: REQ answers with the canned
 * events followed by EOSE, CLOSE stops the subscription, and EVENT is accepted
 * with OK.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { WebSocketServer } from 'ws';

export interface MockUpstreamRelay {
  url: string;
  /** How many REQ messages this relay has answered. */
  reqCount: () => number;
  close: () => Promise<void>;
}

/**
 * Start the mock relay.
 *
 * @param events Events returned for every REQ, in order, before EOSE
 */
export async function startMockUpstreamRelay(events: NostrEvent[]): Promise<MockUpstreamRelay> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let reqCount = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(message) || typeof message[0] !== 'string') {
        return;
      }

      if (message[0] === 'REQ') {
        reqCount += 1;
        const subId = message[1] as string;
        for (const event of events) {
          socket.send(JSON.stringify(['EVENT', subId, event]));
        }
        socket.send(JSON.stringify(['EOSE', subId]));
        return;
      }

      if (message[0] === 'EVENT') {
        const event = message[1] as NostrEvent;
        socket.send(JSON.stringify(['OK', event.id, true, '']));
      }
    });
  });

  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}`,
    reqCount: () => reqCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  };
}
