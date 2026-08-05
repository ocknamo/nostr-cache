// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { type ConnectionStatus, RelayConnection } from './relay-connection.ts';
import { type RelayHost, acquireRelayHost } from './relay-host.ts';

/**
 * Reconnection against the real in-page relay.
 *
 * The unit specs drive rx-nostr through a fake socket, which proves the wiring
 * but not that the emulated socket the widget actually talks to behaves the way
 * rx-nostr needs — in particular that a close reports its status code, which is
 * how rx-nostr tells a dropped connection from one it closed itself. That is
 * only observable end to end, so it is pinned down here: the widget's whole
 * claim to surviving a relay restart rests on it.
 */
describe('RelayConnection against the in-page relay', () => {
  const originalWebSocket = globalThis.WebSocket;
  const hosts: RelayHost[] = [];
  const connections: RelayConnection[] = [];

  /**
   * Hands out the emulated sockets as they are opened.
   *
   * The emulator patches the global constructor, so this resolves it per call
   * and simply records what comes back — closing one is how a test simulates
   * the relay dropping a client.
   */
  function recordingWebSocket(sockets: WebSocket[]): typeof WebSocket {
    return function RecordingWebSocket(url: string) {
      const socket = new globalThis.WebSocket(url);
      sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
  }

  /** The subscriptions the relay currently holds, across all clients. */
  function openSubscriptions(host: RelayHost): { id: string; clientId: string }[] {
    const relay = host.relay as unknown as {
      subscriptionManager: { getAllSubscriptions(): { id: string; clientId: string }[] };
    };
    return relay.subscriptionManager.getAllSubscriptions();
  }

  async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  afterEach(async () => {
    // Drop the clients before the relay: releasing the host restores the global
    // WebSocket, and a client still retrying against the un-intercepted URL
    // would try to open a real socket to `.invalid`.
    for (const connection of connections.splice(0)) {
      connection.disconnect();
    }
    for (const host of hosts.splice(0)) {
      await host.release();
    }
    globalThis.WebSocket = originalWebSocket;
  });

  async function start(): Promise<{
    host: RelayHost;
    connection: RelayConnection;
    sockets: WebSocket[];
    statuses: ConnectionStatus[];
  }> {
    const host = await acquireRelayHost({ dbName: `reconnect-${crypto.randomUUID()}` });
    hosts.push(host);

    const sockets: WebSocket[] = [];
    const statuses: ConnectionStatus[] = [];
    const connection = new RelayConnection({
      webSocketCtor: recordingWebSocket(sockets),
      onStatusChange: (status) => statuses.push(status),
    });
    connections.push(connection);

    await connection.connect(host.interceptUrl);
    return { host, connection, sockets, statuses };
  }

  it('re-opens the socket and re-issues its REQ after the relay drops the client', async () => {
    const { host, connection, sockets, statuses } = await start();
    await host.storage.saveEvent(makeEvent({ id: 'e1', pubkey: 'alice' }));

    const events: NostrEvent[] = [];
    connection.subscribe('sub-1', [{ kinds: [1] }], { onEvent: (event) => events.push(event) });
    await waitFor(() => openSubscriptions(host).length === 1, 'the first subscription');
    const before = openSubscriptions(host)[0];

    // 1006 is what a connection that went away looks like — the relay tearing
    // its side down, rather than this client closing on purpose.
    sockets[0].close(1006);

    await waitFor(() => connection.isConnected, 'the connection to come back');
    await waitFor(() => openSubscriptions(host).length === 1, 'the subscription to be re-issued');

    const after = openSubscriptions(host)[0];
    expect(after.id).toBe(before.id);
    // A fresh socket means a fresh client id: the relay is serving a new
    // connection, not the one that dropped.
    expect(after.clientId).not.toBe(before.clientId);
    expect(sockets.length).toBeGreaterThan(1);
    expect(statuses).toContain('reconnecting');

    // The re-issued REQ is answered from the cache, so the timeline refills.
    await waitFor(() => events.some((event) => event.id === 'e1'), 'the cached event to arrive');
  }, 15000);

  it('stops for good once disconnected', async () => {
    const { host, connection, sockets } = await start();
    connection.subscribe('sub-1', [{ kinds: [1] }], { onEvent: () => {} });
    await waitFor(() => openSubscriptions(host).length === 1, 'the subscription');

    connection.disconnect();

    // No retry: an explicit disconnect must not leave a client hammering a
    // relay the page is about to tear down.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(sockets).toHaveLength(1);
    expect(openSubscriptions(host)).toEqual([]);
    expect(connection.isConnected).toBe(false);
  }, 15000);
});
