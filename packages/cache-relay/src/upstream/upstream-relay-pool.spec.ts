/**
 * What is tested here is the code that is still ours after the move to
 * rx-nostr: the EOSE aggregation, the `upstreamSubId` ⇄ wire-id mapping, and
 * the handful of rx-nostr settings whose absence would silently break the cache
 * (`skipVerify`, and *not* de-duplicating events across relays).
 *
 * rx-nostr's own behaviour — how many times it retries, how it spaces the
 * attempts, that it re-sends REQs after a reconnect — is deliberately not
 * tested: it is the library's contract, and asserting on it here would only
 * produce failures whenever its defaults change.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FakeWebSocket, createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { UpstreamRelayPool } from './upstream-relay-pool.js';

function makeEvent(id: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind: 1, tags: [], content: '', sig: '', ...overrides };
}

/** Let rx-nostr's internal promise chains (REQ dispatch, event routing) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** Pools started by a test, torn down afterwards so no timer outlives it. */
const pools: UpstreamRelayPool[] = [];

interface PoolOptions {
  maxRelays?: number;
  reconnectMaxDelay?: number;
}

function createPool(urls: string[], options: PoolOptions = {}) {
  const fake = createFakeWebSocketFactory();
  const pool = new UpstreamRelayPool(urls, { ...options, webSocketFactory: fake.factory });
  pools.push(pool);
  return { pool, fake };
}

/** Create and start a pool over fake sockets, with a lookup for each relay's socket. */
async function startPool(urls: string[], options: PoolOptions = {}) {
  const { pool, fake } = createPool(urls, options);
  await pool.start();
  await flush();
  const socket = (url: string): FakeWebSocket => {
    const found = fake.forUrl(url);
    if (!found) {
      throw new Error(`no socket opened for ${url}`);
    }
    return found;
  };
  /** Let every relay's socket come up. */
  const connectAll = async () => {
    for (const open of fake.sockets) {
      open.mockOpen();
    }
    await flush();
  };
  return { pool, fake, socket, connectAll };
}

/** The subscription id rx-nostr actually put on the wire for the last REQ. */
function wireSubIdOf(socket: FakeWebSocket): string {
  const reqs = socket.sentOfType('REQ');
  return reqs[reqs.length - 1][1] as string;
}

describe('UpstreamRelayPool', () => {
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.stop()));
    vi.useRealTimers();
  });

  it('fans REQ out to every relay', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    await connectAll();

    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    expect(socket('wss://a').sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);
    expect(socket('wss://b').sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);
  });

  it('replays a REQ that arrived before start()', async () => {
    // The relay opens its transport before the upstream pool, so a client REQ
    // can land in that window.
    const { pool, fake } = createPool(['wss://a']);
    pool.openSubscription('up1', [{ kinds: [1] }]);

    await pool.start();
    await flush();
    fake.last().mockOpen();
    await flush();

    expect(fake.last().sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);
  });

  it('maps the wire subscription id back to the coordinator id on EOSE', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a']);
    await connectAll();

    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.openSubscription('up42', [{ kinds: [1] }]);
    await flush();

    // Answer with exactly the id rx-nostr wrote on the wire, not one we assumed.
    socket('wss://a').mockMessage(['EOSE', wireSubIdOf(socket('wss://a'))]);
    await flush();

    expect(onEose).toHaveBeenCalledWith('up42');
  });

  it('fires aggregated EOSE only after every connected relay answers', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    const onEose = vi.fn();
    pool.onEose(onEose);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).not.toHaveBeenCalled();

    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('fires EOSE immediately (next tick) when no relay is connected', async () => {
    const { pool } = await startPool(['wss://a']);
    const onEose = vi.fn();
    pool.onEose(onEose);

    // The socket was never opened → no relay is connected.
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('only counts relays connected at subscription time (late relay does not stall)', async () => {
    const { pool, socket } = await startPool(['wss://a', 'wss://b']);
    const onEose = vi.fn();
    pool.onEose(onEose);
    // Only relay A is connected when the subscription opens.
    socket('wss://a').mockOpen();
    await flush();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    // Relay B connects late; it is not part of the EOSE aggregate.
    socket('wss://b').mockOpen();
    await flush();

    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('fires aggregated EOSE when a still-pending relay drops before EOSE', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    const onEose = vi.fn();
    pool.onEose(onEose);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    // Relay A answers; only relay B is still pending.
    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).not.toHaveBeenCalled();

    // Relay B drops before it can answer → it no longer owes EOSE, so the
    // aggregate completes instead of stalling until the coordinator timeout.
    socket('wss://b').mockClose();
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('does not fire EOSE early when a dropping relay is not the last pending', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    const onEose = vi.fn();
    pool.onEose(onEose);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    // Relay A drops while relay B is still pending → no EOSE yet.
    socket('wss://a').mockClose();
    await flush();
    expect(onEose).not.toHaveBeenCalled();

    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('forwards upstream events with the originating relay url', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    const onEvent = vi.fn();
    pool.onEvent(onEvent);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    const event = makeEvent('a');
    socket('wss://b').mockMessage(['EVENT', 'up1:0', event]);
    await flush();

    expect(onEvent).toHaveBeenCalledWith('up1', event, 'wss://b');
  });

  it('delivers every relay copy of the same event (no de-duplication)', async () => {
    // The coordinator detects that an upstream returned an already-delivered id
    // and re-arms the freshness window from it. Collapsing the copies here would
    // take that signal away — see doc/cache-relay/upstream.md §5.
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    const onEvent = vi.fn();
    pool.onEvent(onEvent);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    const event = makeEvent('shared');
    socket('wss://a').mockMessage(['EVENT', 'up1:0', event]);
    socket('wss://b').mockMessage(['EVENT', 'up1:0', event]);
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('does not verify signatures itself (validation belongs to the ingest path)', async () => {
    // Verifying here would double the work MessageHandler.ingestUpstreamEvent
    // already does — and would run even under `validateEventsType: 'NONE'`.
    const { pool, socket, connectAll } = await startPool(['wss://a']);
    const onEvent = vi.fn();
    pool.onEvent(onEvent);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    const forged = makeEvent('forged', { sig: 'not-a-signature' });
    socket('wss://a').mockMessage(['EVENT', 'up1:0', forged]);
    await flush();

    expect(onEvent).toHaveBeenCalledWith('up1', forged, 'wss://a');
  });

  it('publishes to every relay', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a', 'wss://b']);
    await connectAll();

    const event = makeEvent('x');
    pool.publish(event);
    await flush();

    expect(socket('wss://a').sent).toContainEqual(['EVENT', event]);
    expect(socket('wss://b').sent).toContainEqual(['EVENT', event]);
  });

  it('closeSubscription sends CLOSE and drops any pending EOSE', async () => {
    const { pool, socket, connectAll } = await startPool(['wss://a']);
    const onEose = vi.fn();
    pool.onEose(onEose);
    await connectAll();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();

    pool.closeSubscription('up1');
    await flush();
    expect(socket('wss://a').sent).toContainEqual(['CLOSE', 'up1:0']);

    // A late EOSE for the closed sub must not fire the callback.
    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).not.toHaveBeenCalled();
  });

  it('reports the connected count', async () => {
    const { pool, socket } = await startPool(['wss://a', 'wss://b']);
    expect(pool.getConnectedCount()).toBe(0);

    socket('wss://a').mockOpen();
    await flush();
    expect(pool.getConnectedCount()).toBe(1);

    socket('wss://b').mockOpen();
    await flush();
    expect(pool.getConnectedCount()).toBe(2);
  });

  it('caps the number of relays at maxRelays', async () => {
    const { fake } = await startPool(['wss://a', 'wss://b', 'wss://c'], { maxRelays: 2 });
    expect(fake.sockets).toHaveLength(2);
  });

  it('de-duplicates repeated relay urls', async () => {
    const { fake } = await startPool(['wss://a', 'wss://a']);
    expect(fake.sockets).toHaveLength(1);
  });

  it('re-arms a relay that rx-nostr has given up on', async () => {
    // Losing an upstream permanently to one outage is not acceptable in a relay
    // process, which — unlike a browser tab — cannot be reloaded.
    vi.useFakeTimers();
    const { pool, fake } = createPool(['wss://a'], { reconnectMaxDelay: 60_000 });
    await pool.start();
    await vi.advanceTimersByTimeAsync(0);

    // Fail the first attempt and every auto-retry, until no new socket appears:
    // that is rx-nostr giving up. 40s clears the longest step of its retry
    // ladder while staying inside the 60s re-arm cooldown.
    let exhausted = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      exhausted = fake.sockets.length;
      fake.last().mockClose();
      await vi.advanceTimersByTimeAsync(40_000);
      if (fake.sockets.length === exhausted) {
        break;
      }
    }

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.sockets.length).toBe(exhausted + 1);
  });
});
