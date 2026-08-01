import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { ProfileStore } from './profile-store.ts';

interface Subscription {
  subId: string;
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
}

/** Records REQ/CLOSE instead of talking to a relay. */
class FakeConnection {
  isConnected = true;
  readonly opened: Subscription[] = [];
  readonly closed: string[] = [];

  subscribe(
    subId: string,
    filters: Filter[],
    handlers: { onEvent: (event: NostrEvent) => void }
  ): void {
    this.opened.push({ subId, filters, onEvent: handlers.onEvent });
  }

  unsubscribe(subId: string): void {
    this.closed.push(subId);
  }

  /** The most recently opened subscription. */
  get latest(): Subscription {
    const subscription = this.opened.at(-1);
    if (!subscription) {
      throw new Error('No subscription was opened');
    }
    return subscription;
  }
}

function profileEvent(pubkey: string, profile: unknown, created_at = 1_700_000_000): NostrEvent {
  return makeEvent({
    id: `id-${pubkey}`,
    pubkey,
    kind: 0,
    created_at,
    content: JSON.stringify(profile),
  });
}

describe('ProfileStore', () => {
  let connection: FakeConnection;
  let changes: Map<string, { name?: string }>[];

  beforeEach(() => {
    vi.useFakeTimers();
    connection = new FakeConnection();
    changes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createStore(options: Partial<ConstructorParameters<typeof ProfileStore>[0]> = {}) {
    return new ProfileStore({
      connection,
      onChange: (profiles) => changes.push(profiles),
      ...options,
    });
  }

  it('coalesces a burst of authors into one subscription', () => {
    const store = createStore();

    store.request(['a']);
    store.request(['b']);
    store.request(['c']);
    expect(connection.opened).toHaveLength(0);

    vi.advanceTimersByTime(200);

    expect(connection.opened).toHaveLength(1);
    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['a', 'b', 'c'] }]);
  });

  it('does not re-subscribe for an author it already asked about', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    store.request(['a']);
    vi.advanceTimersByTime(200);

    expect(connection.opened).toHaveLength(1);
  });

  it('closes the previous subscription when widening the author list', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    store.request(['b']);
    vi.advanceTimersByTime(200);

    expect(connection.opened.map((sub) => sub.subId)).toEqual(['profiles-1', 'profiles-2']);
    expect(connection.closed).toEqual(['profiles-1']);
    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['a', 'b'] }]);
  });

  it('drops authors it already has a profile for from the next filter', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);
    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));

    store.request(['b']);
    vi.advanceTimersByTime(200);

    // Re-asking for 'a' would forward a REQ upstream for a profile already in
    // hand — quadratic across a timeline that gains authors one at a time.
    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['b'] }]);
  });

  it('stops asking for an author whose kind 0 held nothing renderable', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);
    // Profiles with only about/banner/lud16 are common, and parse to nothing.
    connection.latest.onEvent(profileEvent('a', { about: 'hello', banner: 'x' }));

    store.request(['b']);
    vi.advanceTimersByTime(200);

    expect(store.current.has('a')).toBe(false);
    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['b'] }]);
  });

  it('counts the cap against outstanding lookups, not authors ever resolved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ maxAuthors: 2 });

    store.request(['a', 'b']);
    vi.advanceTimersByTime(200);
    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));
    connection.latest.onEvent(profileEvent('b', { name: 'bob' }));

    // Both slots freed up, so a third author is not turned away.
    store.request(['c']);
    vi.advanceTimersByTime(200);

    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['c'] }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens no subscription once every author is resolved', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);
    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));

    // 'a' again plus nothing new: there is nothing left to ask for.
    store.request(['a']);
    vi.advanceTimersByTime(200);

    expect(connection.opened).toHaveLength(1);
  });

  it('keeps asking for an author no relay has a profile for', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    store.request(['b']);
    vi.advanceTimersByTime(200);

    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['a', 'b'] }]);
  });

  it('parses delivered profiles and reports them', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));

    expect(store.current.get('a')).toEqual({ name: 'alice' });
    expect(changes).toHaveLength(1);
  });

  it('keeps the newer profile when an older copy is replayed', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    connection.latest.onEvent(profileEvent('a', { name: 'new' }, 2_000));
    connection.latest.onEvent(profileEvent('a', { name: 'old' }, 1_000));

    expect(store.current.get('a')).toEqual({ name: 'new' });
    expect(changes).toHaveLength(1);
  });

  it('ignores events that are not kind 0', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    connection.latest.onEvent(makeEvent({ pubkey: 'a', kind: 1, content: '{"name":"alice"}' }));

    expect(store.current.size).toBe(0);
  });

  it('reports every delivered kind 0 event through onEvent, even unparseable ones', () => {
    const seen: string[] = [];
    const store = createStore({ onEvent: (event) => seen.push(event.id) });
    store.request(['a']);
    vi.advanceTimersByTime(200);

    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));
    connection.latest.onEvent(makeEvent({ id: 'junk', pubkey: 'b', kind: 0, content: 'not json' }));

    expect(seen).toEqual(['id-a', 'junk']);
    expect(store.current.size).toBe(1);
  });

  it('does not subscribe while the connection is down', () => {
    connection.isConnected = false;
    const store = createStore();

    store.request(['a']);
    vi.advanceTimersByTime(200);

    expect(connection.opened).toHaveLength(0);
  });

  it('retries after a reconnect even when no new author appears', () => {
    connection.isConnected = false;
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);
    expect(connection.opened).toHaveLength(0);

    connection.isConnected = true;
    // 'a' is already wanted, so nothing is added — the retry has to come from
    // the lookup the store knows it still owes.
    store.request(['a']);
    vi.advanceTimersByTime(200);

    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['a'] }]);
  });

  it('stops at the author cap and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ maxAuthors: 2 });

    store.request(['a', 'b', 'c']);
    store.request(['d']);
    vi.advanceTimersByTime(200);

    expect(connection.latest.filters).toEqual([{ kinds: [0], authors: ['a', 'b'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('closes the subscription and stops fetching after close()', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);

    store.close();

    expect(connection.closed).toEqual(['profiles-1']);

    store.request(['b']);
    vi.advanceTimersByTime(200);
    expect(connection.opened).toHaveLength(1);
  });

  it('drops a pending re-subscribe scheduled before close()', () => {
    const store = createStore();
    store.request(['a']);

    store.close();
    vi.advanceTimersByTime(200);

    expect(connection.opened).toHaveLength(0);
  });

  it('keeps already parsed profiles after close()', () => {
    const store = createStore();
    store.request(['a']);
    vi.advanceTimersByTime(200);
    connection.latest.onEvent(profileEvent('a', { name: 'alice' }));

    store.close();

    expect(store.current.get('a')).toEqual({ name: 'alice' });
  });
});
