/**
 * Node.js end-to-end demo for @nostr-cache/cache-relay.
 *
 * Boots an in-process Nostr relay (DexieStorage backed by fake-indexeddb +
 * WebSocketServer), then connects a plain `ws` client that:
 *   1. publishes a signed EVENT and waits for the OK response,
 *   2. opens a REQ subscription and receives the stored event + EOSE,
 *   3. closes the subscription (CLOSE -> CLOSED).
 *
 * Run from the repository root (after `npm run build:cache-relay`):
 *   node examples/node-relay-demo.mjs
 *
 * This script intentionally uses only the public API of
 * `@nostr-cache/cache-relay` and `@nostr-cache/shared`, plus `ws` and
 * `rx-nostr-crypto`, all of which are already available in the workspace's
 * node_modules.
 */

// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import { DexieStorage, NostrCacheRelay, WebSocketServer } from '@nostr-cache/cache-relay';
import { getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from 'rx-nostr-crypto';
import WebSocket from 'ws';

const PORT = 4848;

/**
 * Build a signed kind:1 text note using a freshly generated key.
 */
async function createSignedEvent() {
  // Cryptographically secure 32-byte hex secret key.
  const seckey = getRandomSecret();
  const signer = seckeySigner(seckey);
  const pubkey = await signer.getPublicKey();

  return signer.signEvent({
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Hello from the nostr-cache demo!',
  });
}

/**
 * Wait until the client receives a message satisfying `predicate`.
 */
function waitForMessage(client, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 5000);

    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(message);
      }
    };

    client.on('message', onMessage);
  });
}

async function main() {
  // 1. Start the relay.
  const storage = new DexieStorage('demo-relay');
  const transport = new WebSocketServer(PORT);
  const relay = new NostrCacheRelay(storage, transport, {
    maxSubscriptions: 10,
    validateEventsType: 'IMMEDIATELY',
  });
  await relay.connect();
  console.info(`[relay] listening on ws://localhost:${PORT}`);

  // 2. Connect a WebSocket client.
  const client = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  console.info('[client] connected');

  // 3. Publish an event and wait for the OK response.
  const event = await createSignedEvent();
  const okPromise = waitForMessage(
    client,
    (message) => message[0] === 'OK' && message[1] === event.id,
    'OK'
  );
  client.send(JSON.stringify(['EVENT', event]));
  const ok = await okPromise;
  console.info(`[client] OK received: accepted=${ok[2]} id=${event.id.slice(0, 12)}…`);

  // 4. Subscribe and receive the stored event + EOSE.
  const eventPromise = waitForMessage(
    client,
    (message) => message[0] === 'EVENT' && message[1] === 'demo-sub',
    'EVENT'
  );
  const eosePromise = waitForMessage(
    client,
    (message) => message[0] === 'EOSE' && message[1] === 'demo-sub',
    'EOSE'
  );
  client.send(JSON.stringify(['REQ', 'demo-sub', { kinds: [1] }]));
  const received = await eventPromise;
  await eosePromise;
  console.info(`[client] received event via REQ: "${received[2].content}"`);
  console.info('[client] EOSE received');

  // 5. Close the subscription.
  const closedPromise = waitForMessage(
    client,
    (message) => message[0] === 'CLOSED' && message[1] === 'demo-sub',
    'CLOSED'
  );
  client.send(JSON.stringify(['CLOSE', 'demo-sub']));
  await closedPromise;
  console.info('[client] subscription closed');

  // 6. Tear down.
  client.close();
  await relay.disconnect();
  console.info('[relay] stopped — demo complete ✔');
}

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
