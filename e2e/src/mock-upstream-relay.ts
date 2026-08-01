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

import { createServer } from 'node:https';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { WebSocketServer } from 'ws';

/**
 * Match an event against a REQ filter — enough of NIP-01 for these tests.
 *
 * The widget now opens a second subscription for kind 0 alongside the
 * timeline's, so answering every REQ with every canned event is no longer
 * harmless: `UpstreamCoordinator` trusts upstream to honour the filter and
 * forwards what it receives straight to the client, which would put profile
 * events in the timeline.
 *
 * Only `kinds`, `authors` and `ids` are implemented; an absent field matches
 * everything, as NIP-01 specifies.
 */
function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  return true;
}

export interface MockUpstreamRelay {
  url: string;
  /** How many REQ messages this relay has answered. */
  reqCount: () => number;
  close: () => Promise<void>;
}

export interface MockUpstreamRelayOptions {
  /**
   * Serve `wss://` with the given certificate. Required when the page under
   * test is https: the upstream connection uses the real WebSocket, so a
   * `ws://` upstream would be blocked as mixed content.
   */
  tls?: { key: Buffer; cert: Buffer };
}

/**
 * Start the mock relay.
 *
 * @param events Events returned for every REQ, in order, before EOSE
 * @param options Transport options
 */
export async function startMockUpstreamRelay(
  events: NostrEvent[],
  options: MockUpstreamRelayOptions = {}
): Promise<MockUpstreamRelay> {
  const tlsServer = options.tls ? createServer(options.tls) : undefined;
  const server = tlsServer
    ? new WebSocketServer({ server: tlsServer })
    : new WebSocketServer({ port: 0, host: '127.0.0.1' });
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
        const [, subId, ...filters] = message as ['REQ', string, ...Filter[]];
        for (const event of events) {
          if (filters.some((filter) => matchesFilter(event, filter))) {
            socket.send(JSON.stringify(['EVENT', subId, event]));
          }
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

  if (tlsServer) {
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', () => resolve()));
  } else {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  }

  const address = (tlsServer ?? server).address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `${tlsServer ? 'wss' : 'ws'}://127.0.0.1:${port}`,
    reqCount: () => reqCount,
    close: async () => {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (tlsServer) {
        await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
      }
    },
  };
}
