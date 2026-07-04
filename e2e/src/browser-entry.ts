/**
 * Browser entry point bundled by esbuild and injected into the page.
 *
 * Runs the cache-relay inside the browser using the WebSocketServerEmulator
 * (which monkey-patches globalThis.WebSocket) and real IndexedDB via Dexie,
 * then exposes a tiny NIP-01 client registry on `window.NostrE2E`.
 *
 * Imports reach directly into cache-relay source modules (not the package
 * barrel) because the barrel also exports the Node-only WebSocketServer,
 * which pulls in `ws` and `node:crypto` and cannot be bundled for the browser.
 */

import { NostrCacheRelay } from '../../packages/cache-relay/src/core/nostr-cache-relay.js';
import { DexieStorage } from '../../packages/cache-relay/src/storage/dexie-storage.js';
import { WebSocketServerEmulator } from '../../packages/cache-relay/src/transport/web-socket-server-emulator.js';

type WireMessage = unknown[];

interface ClientRecord {
  socket: WebSocket;
  messages: WireMessage[];
  opened: Promise<void>;
  openSettled: boolean;
  waiters: Array<{ matches: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void }>;
}

// Keep the relay reachable so it (and its transport callbacks) are not GC'd.
let currentRelay: NostrCacheRelay | undefined;
const clients = new Map<number, ClientRecord>();
let nextClientId = 1;

/**
 * Boot an in-browser relay bound to the given emulated WebSocket URL.
 */
export async function startRelay(url: string, dbName = 'NostrCacheRelayE2E'): Promise<void> {
  const storage = new DexieStorage(dbName);
  // Intercept exactly the URL our page client will connect to.
  const transport = new WebSocketServerEmulator(url);
  // The constructor wires transport message/connect handlers.
  currentRelay = new NostrCacheRelay(storage, transport, { validateEventsType: 'IMMEDIATELY' });
  // Start intercepting; the emulator serves this URL in-process (no network).
  await transport.start(url);
}

/**
 * Open a client WebSocket to the emulated relay and start buffering messages.
 * Returns a numeric id used by the other helpers.
 */
export function newClient(url: string): number {
  const id = nextClientId++;
  const socket = new WebSocket(url);

  let resolveOpen!: () => void;
  let rejectOpen!: (err: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  const record: ClientRecord = {
    socket,
    messages: [],
    openSettled: false,
    opened,
    waiters: [],
  };

  // The emulator invokes the onopen/onmessage properties directly, so we must
  // assign them (not addEventListener) and do so synchronously here.
  socket.onopen = () => {
    if (!record.openSettled) {
      record.openSettled = true;
      resolveOpen();
    }
  };
  socket.onerror = () => {
    if (!record.openSettled) {
      record.openSettled = true;
      rejectOpen(new Error('WebSocket error before open'));
    }
  };
  socket.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(event.data) as WireMessage;
    record.messages.push(message);
    for (let i = record.waiters.length - 1; i >= 0; i--) {
      if (record.waiters[i].matches(message)) {
        record.waiters[i].resolve(message);
        record.waiters.splice(i, 1);
      }
    }
  };

  clients.set(id, record);
  return id;
}

/**
 * Resolve once the client connection is open.
 */
export function waitOpen(id: number): Promise<void> {
  return getClient(id).opened;
}

/**
 * Send a wire message from the client.
 */
export function send(id: number, message: WireMessage): void {
  getClient(id).socket.send(JSON.stringify(message));
}

/**
 * Wait for a message with the given type (and optional subscription id at index 1).
 */
export function waitForMessage(
  id: number,
  type: string,
  subscriptionId?: string,
  timeoutMs = 5000
): Promise<WireMessage> {
  const record = getClient(id);
  const matches = (m: WireMessage) =>
    m[0] === type && (subscriptionId === undefined || m[1] === subscriptionId);

  const existing = record.messages.find(matches);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${type} message`));
    }, timeoutMs);
    record.waiters.push({
      matches,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

/**
 * Return all buffered messages for a client.
 */
export function messages(id: number): WireMessage[] {
  return getClient(id).messages;
}

/**
 * Close a client connection.
 */
export function closeClient(id: number): void {
  getClient(id).socket.close();
}

function getClient(id: number): ClientRecord {
  const record = clients.get(id);
  if (!record) throw new Error(`Unknown client id: ${id}`);
  return record;
}
