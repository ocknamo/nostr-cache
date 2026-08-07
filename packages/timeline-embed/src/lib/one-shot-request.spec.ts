import type { Filter } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import {
  DEFAULT_ONE_SHOT_GRACE_MS,
  DEFAULT_ONE_SHOT_TIMEOUT_MS,
  fetchLatestReplaceable,
} from './one-shot-request.ts';
import type { RelayConnection, SubscriptionHandlers } from './relay-connection.ts';

/**
 * Each of these pins down one of the three mistakes that made the profile
 * lookup wrong before it was fixed (see the module's own comment). They are
 * spelled out here because the whole point of the helper is that the follow-list
 * fetch does not get to repeat them.
 */
describe('fetchLatestReplaceable', () => {
  const FILTER: Filter = { kinds: [3], authors: ['a'.repeat(64)] };

  interface Fake {
    connection: RelayConnection;
    /** Handlers of the open subscription, or undefined once it was closed. */
    handlers: () => SubscriptionHandlers | undefined;
    /** Subscription ids the helper closed. */
    closed: string[];
    subId: () => string | undefined;
  }

  /** A connection that records what was subscribed and lets a spec drive it. */
  function fakeConnection(): Fake {
    let openId: string | undefined;
    let openHandlers: SubscriptionHandlers | undefined;
    const closed: string[] = [];
    const connection = {
      subscribe: (subId: string, _filters: Filter[], handlers: SubscriptionHandlers) => {
        openId = subId;
        openHandlers = handlers;
      },
      unsubscribe: (subId: string) => {
        closed.push(subId);
        if (subId === openId) {
          openHandlers = undefined;
        }
      },
    } as unknown as RelayConnection;

    return { connection, handlers: () => openHandlers, closed, subId: () => openId };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the event that arrived, once the grace period is up', async () => {
    const fake = fakeConnection();
    const event = makeEvent({ id: 'e1', kind: 3 });

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    fake.handlers()?.onEvent(event);
    fake.handlers()?.onEose?.();
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS);

    expect(await settled).toBe(event);
  });

  it('keeps listening after EOSE, because EOSE is not "delivered"', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    // A read-through relay emits EOSE the moment the upstream pool reports
    // end-of-stored, without waiting for the events it is still ingesting.
    // Closing here would throw away the very event that was just fetched.
    fake.handlers()?.onEose?.();
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS - 1);
    fake.handlers()?.onEvent(makeEvent({ id: 'late', kind: 3 }));
    await vi.advanceTimersByTimeAsync(1);

    expect((await settled)?.id).toBe('late');
  });

  it('keeps the newest copy rather than the first to arrive', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    fake.handlers()?.onEvent(makeEvent({ id: 'newer', kind: 3, created_at: 200 }));
    fake.handlers()?.onEvent(makeEvent({ id: 'older', kind: 3, created_at: 100 }));
    fake.handlers()?.onEose?.();
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS);

    expect((await settled)?.id).toBe('newer');
  });

  it('gives up when the relay answers with nothing at all', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    // A REQ the relay refuses (subscription cap, storage read failure) gets a
    // NOTICE and neither EOSE nor CLOSED, so nothing but the watchdog ends it.
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_TIMEOUT_MS);

    expect(await settled).toBeUndefined();
    expect(fake.closed).toEqual([fake.subId()]);
  });

  it('settles immediately when the relay closes the subscription', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    fake.handlers()?.onEvent(makeEvent({ id: 'e1', kind: 3 }));
    fake.handlers()?.onClosed?.('too many subscriptions');

    expect((await settled)?.id).toBe('e1');
  });

  it('closes the subscription on every path', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER);
    fake.handlers()?.onEose?.();
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS);
    await settled;

    // This subscription is opened outside the controller's profile
    // bookkeeping, so nothing else would ever close it.
    expect(fake.closed).toEqual([fake.subId()]);
  });

  it('reports every delivery, including the copies it discards', async () => {
    const fake = fakeConnection();
    const seen: string[] = [];

    const settled = fetchLatestReplaceable(fake.connection, FILTER, {
      onEvent: (event) => seen.push(event.id),
    });
    fake.handlers()?.onEvent(makeEvent({ id: 'newer', kind: 3, created_at: 200 }));
    fake.handlers()?.onEvent(makeEvent({ id: 'older', kind: 3, created_at: 100 }));
    fake.handlers()?.onEose?.();
    await vi.advanceTimersByTimeAsync(DEFAULT_ONE_SHOT_GRACE_MS);
    await settled;

    expect(seen).toEqual(['newer', 'older']);
  });

  it('stops and closes when it is aborted mid-flight', async () => {
    const fake = fakeConnection();
    const controller = new AbortController();

    const settled = fetchLatestReplaceable(fake.connection, FILTER, {
      signal: controller.signal,
    });
    fake.handlers()?.onEvent(makeEvent({ id: 'e1', kind: 3 }));
    controller.abort();

    // Nothing is reported back, not even the event that did arrive: the caller
    // is being torn down.
    expect(await settled).toBeUndefined();
    expect(fake.closed).toEqual([fake.subId()]);
  });

  it('opens no subscription at all when it is already aborted', async () => {
    const fake = fakeConnection();
    const controller = new AbortController();
    controller.abort();

    const result = await fetchLatestReplaceable(fake.connection, FILTER, {
      signal: controller.signal,
    });

    expect(result).toBeUndefined();
    expect(fake.subId()).toBeUndefined();
  });

  it('gives concurrent lookups distinct subscription ids', async () => {
    const first = fakeConnection();
    const second = fakeConnection();

    void fetchLatestReplaceable(first.connection, FILTER);
    void fetchLatestReplaceable(second.connection, FILTER);

    expect(first.subId()).not.toBe(second.subId());
  });

  it('honours overridden timings', async () => {
    const fake = fakeConnection();

    const settled = fetchLatestReplaceable(fake.connection, FILTER, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);

    expect(await settled).toBeUndefined();
  });
});
