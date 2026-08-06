/**
 * What is tested here is the code that is still ours after the move to
 * rx-nostr: the EOSE aggregation, the `upstreamSubId` ⇄ wire-id mapping, and
 * the settings whose absence would silently break the cache (`skipVerify`, and
 * *not* de-duplicating events across relays).
 *
 * rx-nostr's own behaviour — how many times it retries, how it spaces the
 * attempts, that it re-sends REQs after a reconnect — is deliberately not
 * tested: it is the library's contract, and asserting on it here would only
 * produce failures whenever its defaults change.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
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

function createPool(urls: string[], options: PoolOptions) {
  const fake = createFakeWebSocketFactory();
  const pool = new UpstreamRelayPool(urls, { ...options, webSocketFactory: fake.factory });
  pools.push(pool);
  const socket = (url: string) => {
    const found = fake.forUrl(url);
    if (!found) {
      throw new Error(`no socket opened for ${url}`);
    }
    return found;
  };
  return { pool, fake, socket };
}

/**
 * Start a pool over fake sockets, optionally bringing the relays up and opening
 * subscription `up1` on `{ kinds: [1] }` — the setup nearly every test wants.
 */
async function startPool(
  urls: string[],
  {
    connect = true,
    subscribe = true,
    ...options
  }: PoolOptions & { connect?: boolean; subscribe?: boolean } = {}
) {
  const created = createPool(urls, options);
  const onEose = vi.fn();
  const onEvent = vi.fn();
  created.pool.onEose(onEose);
  created.pool.onEvent(onEvent);
  await created.pool.start();
  await flush();
  if (connect) {
    for (const socket of created.fake.sockets) {
      socket.mockOpen();
    }
    await flush();
  }
  if (subscribe) {
    created.pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();
  }
  return { ...created, onEose, onEvent };
}

describe('UpstreamRelayPool', () => {
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.stop()));
    vi.useRealTimers();
  });

  it('fans REQ out to every relay under a reversible wire id', async () => {
    const { socket, onEose } = await startPool(['wss://a', 'wss://b']);

    // `up1:0` is what rx-nostr puts on the wire, and answering it must route
    // the EOSE back to the coordinator's `up1`.
    expect(socket('wss://a').sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);
    expect(socket('wss://b').sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);

    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('fires aggregated EOSE once, and only after every connected relay answers', async () => {
    const { socket, onEose } = await startPool(['wss://a', 'wss://b']);

    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).not.toHaveBeenCalled();

    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    // A repeat from a relay that already answered must not fire it again.
    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('fires EOSE immediately (next tick) when no relay is connected', async () => {
    const { onEose } = await startPool(['wss://a'], { connect: false });
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('only counts relays connected at subscription time (late relay does not stall)', async () => {
    const { pool, socket, onEose } = await startPool(['wss://a', 'wss://b'], {
      connect: false,
      subscribe: false,
    });
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

  it('stops waiting on a relay that drops before answering', async () => {
    const { socket, onEose } = await startPool(['wss://a', 'wss://b']);

    // Relay A drops while relay B is still pending → no EOSE yet.
    socket('wss://a').close();
    await flush();
    expect(onEose).not.toHaveBeenCalled();

    // With A gone, B's answer completes the aggregate instead of stalling the
    // client's EOSE until the coordinator timeout.
    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('forwards every relay copy of an event, unverified, with its relay url', async () => {
    // Both properties are load-bearing. The coordinator re-arms the freshness
    // window from an upstream returning an already-delivered id, so collapsing
    // the copies would take that signal away (upstream.md §5); and verifying
    // here would double what MessageHandler.ingestUpstreamEvent does — even
    // under `validateEventsType: 'NONE'`.
    const { socket, onEvent } = await startPool(['wss://a', 'wss://b']);

    const event = makeEvent('shared', { sig: 'not-a-signature' });
    socket('wss://a').mockMessage(['EVENT', 'up1:0', event]);
    socket('wss://b').mockMessage(['EVENT', 'up1:0', event]);
    await flush();

    expect(onEvent).toHaveBeenNthCalledWith(1, 'up1', event, 'wss://a');
    expect(onEvent).toHaveBeenNthCalledWith(2, 'up1', event, 'wss://b');
  });

  it('publishes to every relay', async () => {
    const { pool, socket } = await startPool(['wss://a', 'wss://b'], { subscribe: false });

    const event = makeEvent('x');
    pool.publish(event);
    await flush();

    expect(socket('wss://a').sent).toContainEqual(['EVENT', event]);
    expect(socket('wss://b').sent).toContainEqual(['EVENT', event]);
  });

  it('closeSubscription sends CLOSE and drops any pending EOSE', async () => {
    const { pool, socket, onEose } = await startPool(['wss://a']);

    pool.closeSubscription('up1');
    await flush();
    expect(socket('wss://a').sent).toContainEqual(['CLOSE', 'up1:0']);

    // A late EOSE for the closed sub must not fire the callback.
    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onEose).not.toHaveBeenCalled();
  });

  it('reports the connected count', async () => {
    const { pool, socket } = await startPool(['wss://a', 'wss://b'], {
      connect: false,
      subscribe: false,
    });
    expect(pool.getConnectedCount()).toBe(0);

    socket('wss://a').mockOpen();
    await flush();
    expect(pool.getConnectedCount()).toBe(1);
  });

  it('de-duplicates relay urls and caps them at maxRelays', async () => {
    const { fake } = await startPool(['wss://a', 'wss://a', 'wss://b', 'wss://c'], {
      maxRelays: 2,
      connect: false,
      subscribe: false,
    });
    expect(fake.sockets).toHaveLength(2);
  });

  it('opens a REQ that arrived before start(), and none after stop()', async () => {
    // The relay opens its transport before the upstream pool, so a client REQ
    // can land in that window; after stop() nothing may reconnect.
    const { pool, fake } = createPool(['wss://a'], {});
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();
    fake.last().mockOpen();
    await flush();
    expect(fake.last().sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);

    await pool.stop();
    pool.openSubscription('up2', [{ kinds: [1] }]);
    pool.publish(makeEvent('x'));
    await flush();
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
      fake.last().close();
      await vi.advanceTimersByTimeAsync(40_000);
      if (fake.sockets.length === exhausted) {
        break;
      }
    }

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.sockets.length).toBe(exhausted + 1);
  });
});
