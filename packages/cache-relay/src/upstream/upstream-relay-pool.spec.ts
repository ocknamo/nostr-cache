/**
 * What is tested here is the code that is still ours after the move to
 * rx-nostr: the EOSE aggregation, the `upstreamSubId` ⇄ wire-id mapping, and
 * the settings whose absence would silently break the cache (`skipVerify`, and
 * *not* de-duplicating events across relays).
 *
 * rx-nostr's own behaviour — how many times it retries, how it spaces the
 * attempts — is deliberately not tested: it is the library's contract, and
 * asserting on it here would only produce failures whenever its defaults
 * change. The exception is that it re-sends open REQs after a reconnect, which
 * the temporary relays rely on to get their subscriptions back.
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

/** rx-nostr が一時接続の再試行を使い切り、繋ぎ直し待ちになるまで落とし続ける。 */
async function dropUntilGivenUp(
  pool: UpstreamRelayPool,
  fake: ReturnType<typeof createFakeWebSocketFactory>,
  url: string,
  alsoDrop: string[] = []
): Promise<void> {
  const { retryTimers } = (pool as unknown as { temporary: { retryTimers: Map<string, unknown> } })
    .temporary;
  for (let attempt = 0; attempt < 20 && !retryTimers.has(url); attempt += 1) {
    for (const other of alsoDrop) {
      fake.forUrl(other)?.close();
    }
    fake.forUrl(url)?.close();
    await vi.advanceTimersByTimeAsync(40_000);
  }
  expect(retryTimers.has(url)).toBe(true);
}

/** Pools started by a test, torn down afterwards so no timer outlives it. */
const pools: UpstreamRelayPool[] = [];

interface PoolOptions {
  maxRelays?: number;
  reconnectMaxDelay?: number;
  maxTemporaryRelays?: number;
  temporaryRelayCooldown?: number;
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

  it('fires EOSE immediately (next tick) when nothing can answer', async () => {
    const { pool, onEose } = await startPool(['wss://a'], { connect: false });
    expect(onEose).toHaveBeenCalledTimes(1);

    // Reusing the id replaces the subscription and queues a second microtask.
    // Only the live one fires; the replaced one was closed, not answered.
    pool.openSubscription('up1', [{ kinds: [1] }]);
    pool.openSubscription('up1', [{ kinds: [1] }]);
    await flush();
    expect(onEose).toHaveBeenCalledTimes(2);

    // rx-nostr drops an empty filter list, so no REQ goes out and no relay
    // would ever answer — that must not hang on the coordinator's timeout.
    pool.openSubscription('up2', []);
    await flush();
    expect(onEose).toHaveBeenCalledWith('up2');
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

  it('reports the answer of a relay that connected after the aggregate fired', async () => {
    const { pool, socket } = await startPool(['wss://a', 'wss://b'], {
      connect: false,
      subscribe: false,
    });
    const onResend = vi.fn();
    const onResentEose = vi.fn();
    pool.onResend(onResend);
    pool.onResentEose(onResentEose);
    socket('wss://a').mockOpen();
    await flush();
    pool.openSubscription('up1', [{ kinds: [1] }]);
    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();

    socket('wss://b').mockOpen();
    await flush();
    expect(onResend).toHaveBeenCalledTimes(1);
    socket('wss://b').mockMessage(['EOSE', 'up1:0']);
    await flush();
    expect(onResentEose).toHaveBeenCalledWith('up1');
  });

  it('reports an EVENT before the EOSE that followed it in the same task', async () => {
    const { socket, onEose, onEvent } = await startPool(['wss://a']);
    const order: string[] = [];
    onEvent.mockImplementation(() => order.push('event'));
    onEose.mockImplementation(() => order.push('eose'));

    // Node の ws などは続けて届いたメッセージを同じタスクで流す
    socket('wss://a').mockMessage(['EVENT', 'up1:0', makeEvent('x')]);
    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    await flush();

    expect(order).toEqual(['event', 'eose']);
  });

  it('does not count a deferred EOSE toward a subscription reopened under the same id', async () => {
    const { pool, socket, onEose } = await startPool(['wss://a']);

    socket('wss://a').mockMessage(['EOSE', 'up1:0']);
    pool.closeSubscription('up1');
    pool.openSubscription('up1', [{ kinds: [2] }]);
    await flush();

    expect(onEose).not.toHaveBeenCalled();
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

  it('forwards every relay copy of an event, unverified and unexpired, with its relay url', async () => {
    // Three properties, all load-bearing. The coordinator re-arms the freshness
    // window from an upstream returning an already-delivered id, so collapsing
    // the copies would take that signal away (upstream.md §5). Verifying here
    // would double what MessageHandler.ingestUpstreamEvent does — even under
    // `validateEventsType: 'NONE'`. And dropping expired events (NIP-40) would
    // apply on the upstream path only, which the relay itself does not do.
    const { socket, onEvent } = await startPool(['wss://a', 'wss://b']);

    const event = makeEvent('shared', {
      sig: 'not-a-signature',
      tags: [['expiration', '1']],
    });
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

    // Still nothing just short of the cooldown: the socket below is the pool's
    // re-arm, not another rung of rx-nostr's ladder.
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fake.sockets.length).toBe(exhausted);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sockets.length).toBe(exhausted + 1);

    // stop() must take the pending re-arm with it.
    fake.last().close();
    await vi.advanceTimersByTimeAsync(40_000);
    const beforeStop = fake.sockets.length;
    await pool.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.sockets.length).toBe(beforeStop);
  });

  describe('re-sent answers', () => {
    /** Answer `up1` from every relay, then drop `url` and bring it back. */
    async function reconnectAfterAnswer(url: string) {
      vi.useFakeTimers();
      const started = await startPool(['wss://a', 'wss://b']);
      const onResend = vi.fn();
      const onResentEose = vi.fn();
      started.pool.onResend(onResend);
      started.pool.onResentEose(onResentEose);
      started.socket('wss://a').mockMessage(['EOSE', 'up1:0']);
      started.socket('wss://b').mockMessage(['EOSE', 'up1:0']);
      await flush();

      started.socket(url).close();
      await vi.advanceTimersByTimeAsync(2_000);
      const revived = started.socket(url);
      revived.mockOpen();
      await vi.advanceTimersByTimeAsync(0);
      return { ...started, revived, onResend, onResentEose };
    }

    it('reports a reconnect before the REQ it re-sends is answered', async () => {
      const { revived, onResend, onResentEose, onEose } = await reconnectAfterAnswer('wss://a');

      expect(onResend).toHaveBeenCalledTimes(1);
      expect(revived.sent).toContainEqual(['REQ', 'up1:0', { kinds: [1] }]);
      expect(onResentEose).not.toHaveBeenCalled();

      revived.mockMessage(['EOSE', 'up1:0']);
      revived.mockMessage(['EOSE', 'up1:0']);
      await flush();
      expect(onResentEose).toHaveBeenCalledTimes(1);
      expect(onResentEose).toHaveBeenCalledWith('up1');
      expect(onEose).toHaveBeenCalledTimes(1);
    });

    it('reports an EVENT of the re-sent answer before its EOSE', async () => {
      const { revived, onResentEose, onEvent } = await reconnectAfterAnswer('wss://a');
      const order: string[] = [];
      onEvent.mockImplementation(() => order.push('event'));
      onResentEose.mockImplementation(() => order.push('eose'));

      revived.mockMessage(['EVENT', 'up1:0', makeEvent('e1')]);
      revived.mockMessage(['EOSE', 'up1:0']);
      await flush();
      expect(order).toEqual(['event', 'eose']);
    });

    it('forgets a re-sent answer once its relay drops again or the subscription closes', async () => {
      const { pool, revived, onResentEose } = await reconnectAfterAnswer('wss://a');

      revived.close();
      await flush();
      revived.mockMessage(['EOSE', 'up1:0']);
      pool.closeSubscription('up1');
      await flush();
      expect(onResentEose).not.toHaveBeenCalled();
    });

    it('leaves a reconnect during the first answer to the aggregated EOSE', async () => {
      vi.useFakeTimers();
      const { pool, socket, onEose } = await startPool(['wss://a', 'wss://b']);
      const onResend = vi.fn();
      const onResentEose = vi.fn();
      pool.onResend(onResend);
      pool.onResentEose(onResentEose);

      socket('wss://a').close();
      await vi.advanceTimersByTimeAsync(2_000);
      socket('wss://a').mockOpen();
      await vi.advanceTimersByTimeAsync(0);
      socket('wss://a').mockMessage(['EOSE', 'up1:0']);
      socket('wss://b').mockMessage(['EOSE', 'up1:0']);
      await flush();

      expect(onResend).not.toHaveBeenCalled();
      expect(onResentEose).not.toHaveBeenCalled();
      expect(onEose).toHaveBeenCalledTimes(1);
    });
  });

  describe('targeted subscriptions', () => {
    /** Bring the targeted socket up and return its wire sub id. */
    async function openTarget(fake: ReturnType<typeof createFakeWebSocketFactory>, url: string) {
      await flush();
      const target = fake.forUrl(url);
      if (!target) {
        throw new Error(`no socket for ${url}`);
      }
      target.mockOpen();
      await flush();
      return target;
    }

    it('sends the REQ only to its targets and waits on them alone for EOSE', async () => {
      const { pool, fake, socket, onEose } = await startPool(['wss://a'], { subscribe: false });

      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://outbox/']);
      const target = await openTarget(fake, 'wss://outbox');

      expect(target.sent).toContainEqual(['REQ', 'up1.0:0', { kinds: [1] }]);
      expect(socket('wss://a').sent).toEqual([]);
      expect(onEose).not.toHaveBeenCalled();

      // 末尾スラッシュ付きで渡しても、rx-nostr が正規化した送り元と突き合う
      target.mockMessage(['EOSE', 'up1.0:0']);
      await flush();
      expect(onEose).toHaveBeenCalledWith('up1.0');
    });

    it('does not make other subscriptions wait on a temporary connection', async () => {
      const { pool, fake, socket, onEose } = await startPool(['wss://a'], { subscribe: false });
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://outbox']);
      await openTarget(fake, 'wss://outbox');

      pool.openSubscription('up2', [{ kinds: [1] }]);
      await flush();
      socket('wss://a').mockMessage(['EOSE', 'up2:0']);
      await flush();

      expect(onEose).toHaveBeenCalledWith('up2');
      expect(pool.getConnectedCount()).toBe(1);
    });

    it('closes the targeted REQ, freeing its slot', async () => {
      const { pool, fake } = await startPool(['wss://a'], {
        subscribe: false,
        maxTemporaryRelays: 1,
      });
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://one']);
      const target = await openTarget(fake, 'wss://one');
      expect(pool.canReach('wss://two')).toBe(false);
      expect(pool.canReach('wss://one/')).toBe(true);

      pool.closeSubscription('up1.0');
      await flush();

      expect(target.sent).toContainEqual(['CLOSE', 'up1.0:0']);
      expect(pool.canReach('wss://two')).toBe(true);
    });

    it('lets the temporary socket close once the targeted REQ is closed', async () => {
      // 書き込みの一時接続（rx-nostr 3.7 の confirmOK の不具合）と違い、REQ のものは閉じる
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], {});
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://outbox']);
      await vi.advanceTimersByTimeAsync(0);
      const target = fake.forUrl('wss://outbox');
      target?.mockOpen();
      await vi.advanceTimersByTimeAsync(0);

      pool.closeSubscription('up1.0');
      await vi.advanceTimersByTimeAsync(11_000);

      expect(target?.readyState).toBe(3);
      await pool.stop();
    });

    it('answers at once, sending nothing, when no target can be reached', async () => {
      const { pool, fake, onEose } = await startPool(['wss://a'], {
        subscribe: false,
        maxTemporaryRelays: 1,
      });
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://one']);
      await openTarget(fake, 'wss://one');

      pool.openSubscription('up1.1', [{ kinds: [1] }], ['wss://two']);
      await flush();

      expect(onEose).toHaveBeenCalledWith('up1.1');
      expect(fake.forUrl('wss://two')).toBeUndefined();
    });

    it('cools down a temporary relay rx-nostr gives up on, then reconnects it with its REQs', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], {
        reconnectMaxDelay: 60_000,
        temporaryRelayCooldown: 600_000,
      });
      const onEose = vi.fn();
      pool.onEose(onEose);
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);

      await dropUntilGivenUp(pool, fake, 'wss://dead');

      expect(pool.canReach('wss://dead')).toBe(false);
      expect(onEose).toHaveBeenCalledWith('up1.0');
      const recoveryTimers = (pool as unknown as { recoveryTimers: Map<string, unknown> })
        .recoveryTimers;
      expect([...recoveryTimers.keys()]).not.toContain('wss://dead');

      // 既定の上流のような再武装はせず、冷却が明けてから繋ぎ直す
      const before = fake.sockets.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(pool.canReach('wss://dead')).toBe(true);
      expect(fake.sockets.length).toBe(before + 1);
      const revived = fake.last();
      revived.mockOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(revived.sent).toContainEqual(['REQ', 'up1.0:0', { kinds: [1] }]);

      // 新しい REQ も同じ接続に乗る
      pool.openSubscription('up2.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      expect(revived.sent).toContainEqual(['REQ', 'up2.0:0', { kinds: [1] }]);
      revived.mockMessage(['EOSE', 'up2.0:0']);
      await vi.advanceTimersByTimeAsync(0);
      expect(onEose).toHaveBeenCalledWith('up2.0');
      await pool.stop();
    });

    it('reports the re-sent answer of a temporary relay it reconnected', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { temporaryRelayCooldown: 600_000 });
      const onResend = vi.fn();
      const onResentEose = vi.fn();
      pool.onResend(onResend);
      pool.onResentEose(onResentEose);
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      await dropUntilGivenUp(pool, fake, 'wss://dead');

      await vi.advanceTimersByTimeAsync(600_000);
      const revived = fake.last();
      revived.mockOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(onResend).toHaveBeenCalledWith('wss://dead');

      revived.mockMessage(['EOSE', 'up1.0:0']);
      await vi.advanceTimersByTimeAsync(0);
      expect(onResentEose).toHaveBeenCalledWith('up1.0');
      await pool.stop();
    });

    it('resends only the subscriptions still open when the cooldown ends', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { temporaryRelayCooldown: 1_000_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      pool.openSubscription('up2.0', [{ kinds: [2] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      await dropUntilGivenUp(pool, fake, 'wss://dead');

      pool.closeSubscription('up1.0');
      await vi.advanceTimersByTimeAsync(1_000_000);
      const revived = fake.forUrl('wss://dead');
      revived?.mockOpen();
      await vi.advanceTimersByTimeAsync(0);

      expect(revived?.sent).toContainEqual(['REQ', 'up2.0:0', { kinds: [2] }]);
      expect(revived?.sent).not.toContainEqual(['REQ', 'up1.0:0', { kinds: [1] }]);
      await pool.stop();
    });

    it('does not reconnect once every subscription closed during the cooldown', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { temporaryRelayCooldown: 1_000_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      await dropUntilGivenUp(pool, fake, 'wss://dead');

      pool.closeSubscription('up1.0');
      const before = fake.sockets.length;
      await vi.advanceTimersByTimeAsync(1_000_000);

      expect(fake.sockets.length).toBe(before);
      await pool.stop();
    });

    it('does not reconnect a temporary relay that rejected us', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { temporaryRelayCooldown: 1_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://picky']);
      await vi.advanceTimersByTimeAsync(0);

      fake.forUrl('wss://picky')?.close(4000);
      const before = fake.sockets.length;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(fake.sockets.length).toBe(before);
      await pool.stop();
    });

    it('drops a pending reconnect on stop', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { temporaryRelayCooldown: 1_000_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      await dropUntilGivenUp(pool, fake, 'wss://dead');

      await pool.stop();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not cool down targets that dropped while we were offline ourselves', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], { reconnectMaxDelay: 60_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://far']);
      await vi.advanceTimersByTimeAsync(0);

      // 既定の上流も宛先も繋がらない＝自分側の断線
      await dropUntilGivenUp(pool, fake, 'wss://far', ['wss://a']);

      expect(pool.canReach('wss://far')).toBe(true);
      // 冷却しないので、待つ間の購読も同じ接続に乗り、繋ぎ直すときに一緒に送られる
      pool.openSubscription('up2.0', [{ kinds: [2] }], ['wss://far']);
      await vi.advanceTimersByTimeAsync(0);

      // 繋ぎ直しは少し置いてから（既定の上流の再武装と同じ間隔）
      const before = fake.sockets.filter((socket) => socket.url === 'wss://far').length;
      await vi.advanceTimersByTimeAsync(60_000);
      const far = fake.sockets.filter((socket) => socket.url === 'wss://far');
      expect(far.length).toBe(before + 1);
      far[far.length - 1].mockOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(far[far.length - 1].sent).toContainEqual(['REQ', 'up1.0:0', { kinds: [1] }]);
      expect(far[far.length - 1].sent).toContainEqual(['REQ', 'up2.0:0', { kinds: [2] }]);
      await pool.stop();
    });

    it('evicts only idle temporary clients when making room', async () => {
      const { pool, fake } = await startPool(['wss://a'], {
        subscribe: false,
        maxTemporaryRelays: 2,
      });
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://busy']);
      pool.openSubscription('up2.0', [{ kinds: [1] }], ['wss://idle']);
      await flush();
      const busy = await openTarget(fake, 'wss://busy');
      const idle = await openTarget(fake, 'wss://idle');
      pool.closeSubscription('up2.0');

      pool.openSubscription('up3.0', [{ kinds: [1] }], ['wss://new']);
      await flush();

      expect(busy.readyState).toBe(1);
      expect(idle.readyState).toBe(3);
      expect(fake.forUrl('wss://new')).toBeDefined();
    });

    it('keeps the slot of a rebuilt client when an old subscription closes', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], {
        maxTemporaryRelays: 1,
        temporaryRelayCooldown: 1_000,
      });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://r']);
      await vi.advanceTimersByTimeAsync(0);
      // 拒まれた接続は捨てるので、冷却明けの購読は作り直した接続に乗る
      fake.forUrl('wss://r')?.close(4000);
      await vi.advanceTimersByTimeAsync(1_000);

      pool.openSubscription('up2.0', [{ kinds: [1] }], ['wss://r']);
      pool.closeSubscription('up1.0');

      expect(pool.canReach('wss://other')).toBe(false);
      await pool.stop();
    });

    it('frees the slot of a relay waiting to reconnect, and gives it up if the slot is gone', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a'], {
        maxTemporaryRelays: 1,
        temporaryRelayCooldown: 1_000_000,
      });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      fake.forUrl('wss://a')?.mockOpen();
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://dead']);
      await vi.advanceTimersByTimeAsync(0);
      await dropUntilGivenUp(pool, fake, 'wss://dead');

      expect(pool.canReach('wss://live')).toBe(true);
      pool.openSubscription('up2.0', [{ kinds: [1] }], ['wss://live']);
      await vi.advanceTimersByTimeAsync(0);
      const dead = () => fake.sockets.filter((socket) => socket.url === 'wss://dead').length;
      const before = dead();
      await vi.advanceTimersByTimeAsync(1_000_000);

      expect(dead()).toBe(before);
      await pool.stop();
    });

    it('cools down a temporary relay that rejects the connection', async () => {
      const { pool, fake } = await startPool(['wss://a'], { subscribe: false });
      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://picky']);
      await flush();
      fake.forUrl('wss://picky')?.mockOpen();
      await flush();

      fake.forUrl('wss://picky')?.close(4000);
      await flush();

      expect(pool.canReach('wss://picky')).toBe(false);
    });

    it('counts a slot once when a targeted id is reopened', async () => {
      const { pool } = await startPool(['wss://a'], { subscribe: false, maxTemporaryRelays: 1 });

      pool.openSubscription('up1.0', [{ kinds: [1] }], ['wss://one']);
      pool.openSubscription('up1.0', [{ kinds: [2] }], ['wss://one']);
      pool.closeSubscription('up1.0');

      expect(pool.canReach('wss://two')).toBe(true);
    });

    it('still re-arms a default relay configured with a trailing slash', async () => {
      vi.useFakeTimers();
      const { pool, fake } = createPool(['wss://a.example.com/'], { reconnectMaxDelay: 60_000 });
      await pool.start();
      await vi.advanceTimersByTimeAsync(0);
      const recoveryTimers = (pool as unknown as { recoveryTimers: Map<string, unknown> })
        .recoveryTimers;

      for (let attempt = 0; attempt < 20 && recoveryTimers.size === 0; attempt += 1) {
        fake.last().close();
        await vi.advanceTimersByTimeAsync(40_000);
      }

      expect([...recoveryTimers.keys()]).toEqual(['wss://a.example.com']);
      await pool.stop();
    });
  });
});
