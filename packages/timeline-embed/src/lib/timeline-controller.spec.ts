// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEvent, seedValidated } from '../test-fixtures.ts';
import { parsePostTarget } from './post-target.ts';
import {
  RelayConnection,
  type RelayConnectionOptions,
  type SubscriptionHandlers,
} from './relay-connection.ts';
import { type RelayHost, acquireRelayHost, getRelayHostRefCount } from './relay-host.ts';
import {
  type FollowsState,
  TimelineController,
  type TimelineState,
} from './timeline-controller.ts';

/**
 * The controller is where the timeline subscription, the profile subscription
 * and the shared relay meet, so the things worth pinning down here are the
 * lifecycle ones: every path that stops the timeline must also stop the profile
 * lookups, or the demo's cold benchmark keeps refilling the cache it is
 * measuring and the page leaks a subscription per filter change.
 *
 * These run against the real in-page relay (cache-only: no upstream relays are
 * configured), which is what makes the assertions about REQ/CLOSE meaningful.
 */
describe('TimelineController', () => {
  const controllers: TimelineController[] = [];
  const seeded: RelayHost[] = [];
  const originalWebSocket = globalThis.WebSocket;

  /**
   * Milliseconds a profile lookup is held open after EOSE, for the specs that
   * need to catch one in flight.
   *
   * Production closes on EOSE (the relay orders it after the events it has
   * accepted), which leaves no window to observe. A spec asserting "this path
   * closes the subscription" has to be given one to close.
   */
  const OBSERVABLE_GRACE_MS = 500;

  function createController(
    dbName = `controller-${crypto.randomUUID()}`,
    options: { validationPollIntervalMs?: number; profileEoseGraceMs?: number } = {}
  ): {
    controller: TimelineController;
    states: TimelineState[];
  } {
    const states: TimelineState[] = [];
    const controller = new TimelineController({
      host: { dbName },
      ...options,
      onChange: (state) => states.push(state),
    });
    controllers.push(controller);
    return { controller, states };
  }

  /**
   * The subscription ID the relay sees for one of the controller's.
   *
   * The controller names its subscriptions `timeline-N` / `profile-N`, and
   * rx-nostr puts a forward-strategy REQ on the wire as `${id}:0` — the child
   * index is pinned to 0 because a forward REQ overwrites its predecessor.
   */
  function wireSubId(id: string): string {
    return `${id}:0`;
  }

  /** The subscriptions the controller currently has open on the relay. */
  function openSubscriptions(controller: TimelineController): { id: string; filters: Filter[] }[] {
    const relay = controller.host?.relay as unknown as {
      subscriptionManager: { getAllSubscriptions(): { id: string; filters: Filter[] }[] };
    };
    return relay.subscriptionManager.getAllSubscriptions();
  }

  function openSubscriptionIds(controller: TimelineController): string[] {
    return openSubscriptions(controller).map((subscription) => subscription.id);
  }

  /** The profile lookups currently in flight. */
  function profileSubscriptions(
    controller: TimelineController
  ): { id: string; filters: Filter[] }[] {
    return openSubscriptions(controller).filter((sub) => sub.id.startsWith('profile-'));
  }

  function profileSubscription(
    controller: TimelineController
  ): { id: string; filters: Filter[] } | undefined {
    return profileSubscriptions(controller)[0];
  }

  interface QueueInternals {
    requested: Set<string>;
    pending: unknown[];
  }

  /**
   * Reached through private fields: the in-flight budget and the de-duplication
   * set are not on any public surface. No field is optional, so a rename fails
   * loudly rather than reading as "nothing in flight".
   */
  function lookups(controller: TimelineController): {
    profiles: { subs: Map<string, unknown>; queue: QueueInternals };
    embeds: { inFlight: number; queue: QueueInternals };
  } {
    return controller as unknown as ReturnType<typeof lookups>;
  }

  /**
   * Lookups holding one of the controller's in-flight slots.
   *
   * Read from the controller rather than the relay because that is the budget
   * under test, and because it is taken synchronously — rx-nostr dispatches the
   * REQ itself a microtask later, through a queue that consults NIP-11 limits.
   */
  function inFlightProfiles(controller: TimelineController): number {
    return lookups(controller).profiles.subs.size;
  }

  /**
   * Put events straight into the cache the controller will read from.
   *
   * Acquiring the host up front means the controller (configured with the same
   * db name) joins the very same relay instead of starting a second one.
   */
  async function seedCache(
    dbName: string,
    events: NostrEvent[],
    options: { validated?: boolean } = {}
  ): Promise<void> {
    const host = await acquireRelayHost({ dbName });
    seeded.push(host);
    if (options.validated === false) {
      for (const event of events) {
        await host.storage.saveEvent(event);
      }
      return;
    }
    await seedValidated(host.storage, events);
  }

  async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /**
   * Hand out the sockets the controller opens.
   *
   * It builds its own connection, so the only way to reach the socket is to
   * wrap the constructor it resolves at connect time — which is the emulator's
   * patched global, already installed by the time the host has been acquired.
   * Closing one is how a test makes the relay drop a client.
   */
  function captureSockets(): WebSocket[] {
    const patched = globalThis.WebSocket;
    const sockets: WebSocket[] = [];
    globalThis.WebSocket = function Capturing(url: string) {
      const socket = new patched(url);
      sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    return sockets;
  }

  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      await controller.stop();
    }
    for (const host of seeded.splice(0)) {
      await host.release();
    }
    globalThis.WebSocket = originalWebSocket;
  });

  it('publishes a profile map from the very first snapshot', async () => {
    const { controller, states } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);

    // Consumers destructure this before any kind 0 has arrived, so it has to be
    // a Map from the start rather than undefined.
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.profiles).toBeInstanceOf(Map);
    }
  });

  it('opens no profile subscription until a card asks for one', async () => {
    const { controller } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);

    // Lookups are driven by cards scrolling into view, so a timeline nobody has
    // looked at yet costs exactly one subscription.
    await waitFor(
      () => openSubscriptionIds(controller).includes(wireSubId('timeline-1')),
      'the timeline subscription'
    );
    expect(profileSubscription(controller)).toBeUndefined();
  });

  it('closes both subscriptions on suspend', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [makeEvent({ id: 'e1', pubkey: 'alice' })]);
    const { controller } = createController(dbName, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);
    // Wait for the profile subscription to exist, or the assertion below would
    // hold just as well against a suspend() that closes nothing.
    controller.requestProfile('alice');
    await waitFor(() => profileSubscription(controller) !== undefined, 'the profile subscription');

    controller.suspend();

    await waitFor(
      () => !openSubscriptionIds(controller).includes(wireSubId('timeline-1')),
      'the timeline subscription to close'
    );
    // A profile subscription surviving here would keep reading through to
    // upstream and refill the cache the caller is about to measure cold.
    expect(profileSubscription(controller)).toBeUndefined();
  });

  it('replaces the subscription on applyFilter instead of accumulating them', async () => {
    const { controller } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);

    controller.applyFilter([{ kinds: [1], limit: 5 }]);

    await waitFor(
      () => openSubscriptionIds(controller).includes(wireSubId('timeline-2')),
      'the replacement subscription'
    );
    expect(openSubscriptionIds(controller)).not.toContain(wireSubId('timeline-1'));
  });

  it('sends every filter on one subscription rather than one REQ each', async () => {
    const { controller } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);

    controller.applyFilter([
      { kinds: [1], limit: 10 },
      { kinds: [6], limit: 5 },
    ]);

    await waitFor(
      () => openSubscriptionIds(controller).includes(wireSubId('timeline-2')),
      'the replacement subscription'
    );
    const timelineSubs = openSubscriptions(controller).filter(
      (sub) => sub.id === wireSubId('timeline-2')
    );
    expect(timelineSubs).toHaveLength(1);
    expect(timelineSubs[0].filters).toEqual([
      { kinds: [1], limit: 10 },
      { kinds: [6], limit: 5 },
    ]);
  });

  it('keeps profiles across a filter change so authors do not flicker', async () => {
    const { controller, states } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);
    const before = states.at(-1)?.profiles;

    controller.applyFilter([{ kinds: [1], limit: 5 }]);

    // Events and origins are cleared for the new subscription; profiles are
    // deliberately not, because re-fetching them would blank every author name.
    const after = states.at(-1);
    expect(after?.events).toEqual([]);
    expect(after?.profiles).toEqual(before);
  });

  it('asks for one author per subscription', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [makeEvent({ id: 'e1', pubkey: 'alice' })]);
    const { controller } = createController(dbName, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);

    controller.requestProfile('alice');
    controller.requestProfile('bob');
    await waitFor(() => profileSubscriptions(controller).length === 2, 'both lookups to open');

    // One author per filter is what lets the relay's freshness window decide
    // per author: a filter naming several is forwarded upstream in full as soon
    // as any one of them is missing from the cache.
    const filters = profileSubscriptions(controller).map((sub) => sub.filters);
    expect(filters).toEqual([
      [{ kinds: [0], authors: ['alice'] }],
      [{ kinds: [0], authors: ['bob'] }],
    ]);
  });

  it('opens no lookup while suspended, and resumes with the next filter', async () => {
    const { controller } = createController(undefined, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);

    controller.suspend();
    // The cards are still on screen while the demo measures a cold cache, so
    // one scrolling into view must not read through and refill it.
    controller.requestProfile('alice');
    expect(inFlightProfiles(controller)).toBe(0);

    controller.applyFilter([{ kinds: [1], limit: 10 }]);
    controller.requestProfile('alice');

    expect(inFlightProfiles(controller)).toBe(1);
    await waitFor(() => profileSubscriptions(controller).length === 1, 'the resumed lookup');
  });

  it('gives a slot back when the relay answers a lookup with nothing at all', async () => {
    const { controller } = createController(undefined, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);
    // A REQ the relay refuses gets a NOTICE and no EOSE or CLOSED — that is
    // what a storage read failure or the subscription cap looks like from here.
    const connection = (controller as unknown as { connection: { subscribe: () => void } })
      .connection;
    const realSubscribe = connection.subscribe;
    connection.subscribe = () => {};

    for (const pubkey of ['a', 'b', 'c', 'd', 'e']) {
      controller.requestProfile(pubkey);
    }
    expect(profileSubscriptions(controller)).toHaveLength(0);

    connection.subscribe = realSubscribe;
    // Without the watchdog the four slots stay taken for good and every later
    // author is stuck on a shortened pubkey until the page is reloaded.
    await waitFor(
      () => inFlightProfiles(controller) === 0,
      'the stuck lookups to time out',
      // Longer than PROFILE_REQUEST_TIMEOUT_MS, which is what is under test.
      8000
    );
    controller.requestProfile('f');
    await waitFor(() => profileSubscriptions(controller).length === 1, 'the recovered slot');
  }, 10000);

  it('ignores a repeat request for an author already asked about', async () => {
    const { controller } = createController(undefined, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);

    // Synchronous, so neither lookup can have finished in between: the same
    // card scrolling out and back must not re-open a subscription.
    controller.requestProfile('alice');
    controller.requestProfile('alice');

    expect(inFlightProfiles(controller)).toBe(1);
    await waitFor(() => profileSubscriptions(controller).length === 1, 'the single lookup');
  });

  it('caps how many lookups run at once, then drains the queue', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    const authors = ['a', 'b', 'c', 'd', 'e', 'f'];
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'a' }),
      ...authors.map((pubkey) =>
        makeEvent({
          id: `p-${pubkey}`,
          pubkey,
          kind: 0,
          content: JSON.stringify({ name: pubkey }),
        })
      ),
    ]);
    const { controller, states } = createController(dbName);
    await controller.start([{ kinds: [1], limit: 10 }]);

    for (const pubkey of authors) {
      controller.requestProfile(pubkey);
    }

    // The relay caps a client at 20 subscriptions and an iframe sized to its
    // content can have every card visible at once, so the burst has to queue.
    expect(inFlightProfiles(controller)).toBe(4);

    await waitFor(
      () => (states.at(-1)?.profiles.size ?? 0) === authors.length,
      'every queued lookup to deliver'
    );
    // Each lookup lingers for the post-EOSE grace period, then closes: nothing
    // is left holding a subscription once the queue has drained.
    await waitFor(
      () => profileSubscriptions(controller).length === 0,
      'every lookup to close itself'
    );
  });

  it('resumes queued profile lookups after the connection comes back', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'alice' }),
      makeEvent({
        id: 'p-alice',
        pubkey: 'alice',
        kind: 0,
        content: JSON.stringify({ name: 'alice' }),
      }),
    ]);
    const sockets = captureSockets();
    const { controller, states } = createController(dbName);
    await controller.start([{ kinds: [1], limit: 10 }]);
    await waitFor(() => sockets.length > 0, "the controller's socket");

    // Drop the connection the way a relay going away does.
    sockets[0].close(1006);
    await waitFor(() => states.at(-1)?.status !== 'connected', 'the drop to be noticed');

    // Asking now must not be thrown away. The lookup cannot be opened while the
    // socket is down — it would burn an in-flight slot and run down its
    // watchdog — so it waits in the queue instead.
    controller.requestProfile('alice');
    expect(inFlightProfiles(controller)).toBe(0);

    await waitFor(() => states.at(-1)?.status === 'connected', 'the reconnection', 8000);
    // Reconnecting is what drains the queue: nothing else would, because the
    // cards that asked have already been rendered.
    await waitFor(
      () => states.at(-1)?.profiles.get('alice') !== undefined,
      'the queued lookup to run once reconnected',
      8000
    );
    expect(states.at(-1)?.profiles.get('alice')).toEqual({ name: 'alice' });
  }, 20000);

  it('renders a delivered profile and ignores an older copy of it', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    // Seeded straight into storage, which is keyed by event id and does not
    // apply the replaceable rule — so both versions survive and get delivered,
    // the way two upstream relays each answering with their own copy would.
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'alice', created_at: 1_700_000_100 }),
      makeEvent({
        id: 'p-old',
        pubkey: 'alice',
        kind: 0,
        created_at: 1_700_000_400,
        content: JSON.stringify({ name: 'old-alice' }),
      }),
      makeEvent({
        id: 'p-new',
        pubkey: 'alice',
        kind: 0,
        created_at: 1_700_000_500,
        content: JSON.stringify({ name: 'alice' }),
      }),
    ]);
    const { controller, states } = createController(dbName);

    await controller.start([{ kinds: [1], limit: 10 }]);
    controller.requestProfile('alice');
    await waitFor(
      () => states.at(-1)?.profiles.get('alice') !== undefined,
      "alice's profile to arrive"
    );

    // Both copies really were delivered (note + two kind 0), so the guard is
    // what decided the outcome rather than the relay only ever sending one.
    await waitFor(
      () => (controller.metrics?.snapshot().delivered ?? 0) >= 3,
      'all three events to be delivered'
    );
    // Newest-first delivery means the older copy lands second; without the
    // created_at guard it would overwrite the newer name.
    expect(states.at(-1)?.profiles.get('alice')).toEqual({ name: 'alice' });
  });

  it('counts every delivered kind 0, including one it cannot parse', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'alice' }),
      makeEvent({ id: 'p1', pubkey: 'alice', kind: 0, content: 'not json' }),
    ]);
    const { controller } = createController(dbName);

    await controller.start([{ kinds: [1], limit: 10 }]);
    controller.requestProfile('alice');
    await waitFor(
      () => (controller.metrics?.snapshot().delivered ?? 0) >= 2,
      'both deliveries to be classified'
    );

    // Classification happens before parsing on purpose: the upstream pool
    // counts kind 0 arrivals either way, so skipping the unparseable ones here
    // would leave the counters describing different populations.
    expect(controller.metrics?.snapshot().delivered).toBe(2);
  });

  it('closes the profile subscription on stop', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [makeEvent({ id: 'e1', pubkey: 'alice' })]);
    const { controller } = createController(dbName, { profileEoseGraceMs: OBSERVABLE_GRACE_MS });
    await controller.start([{ kinds: [1], limit: 10 }]);
    controller.requestProfile('alice');
    await waitFor(() => profileSubscription(controller) !== undefined, 'the profile subscription');

    const host = controller.host;
    await controller.stop();

    const relay = host?.relay as unknown as {
      subscriptionManager: { getAllSubscriptions(): { id: string }[] };
    };
    expect(relay.subscriptionManager.getAllSubscriptions()).toEqual([]);
  });

  it('releases the shared relay on stop', async () => {
    const { controller } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);
    expect(getRelayHostRefCount()).toBe(1);

    await controller.stop();

    expect(getRelayHostRefCount()).toBe(0);
    expect(controller.host).toBeUndefined();
  });

  it('is safe to stop twice', async () => {
    const { controller } = createController();
    await controller.start([{ kinds: [1], limit: 10 }]);

    await controller.stop();
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(getRelayHostRefCount()).toBe(0);
  });

  /**
   * Paging is the one path that adds to the timeline without the subscription
   * doing it, so the things worth pinning down are that it appends rather than
   * replaces, and that every way of running out stops it — a page that keeps
   * asking costs the embedding page a read-through per scroll.
   */
  describe('loadOlder', () => {
    const AUTHOR = 'a'.repeat(64);

    // Some of these stub the connection; the outer teardown stops controllers,
    // which needs the real one back.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** `n` notes one second apart, newest first, as a timeline holds them. */
    function notes(count: number, from = 1_700_000_000): NostrEvent[] {
      return Array.from({ length: count }, (_, index) =>
        makeEvent({
          id: `${index}`.padStart(64, 'e'),
          pubkey: AUTHOR,
          created_at: from - index,
          content: `note ${index}`,
        })
      );
    }

    /** Start on a seeded cache and wait for the first page to settle. */
    async function startPaged(
      events: NostrEvent[],
      filters: Filter[] = [{ kinds: [1], authors: [AUTHOR], limit: 2 }],
      options: { maxEvents?: number } = {}
    ) {
      const dbName = `paging-${crypto.randomUUID()}`;
      await seedCache(dbName, events);
      const states: TimelineState[] = [];
      const controller = new TimelineController({
        host: { dbName },
        maxEvents: options.maxEvents,
        onChange: (state) => states.push(state),
      });
      controllers.push(controller);
      await controller.start(filters);
      await waitFor(() => last(states).eose, 'the first page to arrive');
      return { controller, states };
    }

    function last(states: TimelineState[]): TimelineState {
      return states[states.length - 1];
    }

    function contents(state: TimelineState): string[] {
      return state.events.map((event) => event.content);
    }

    it('appends the next page rather than replacing what is on screen', async () => {
      const { controller, states } = await startPaged(notes(5));
      expect(contents(last(states))).toEqual(['note 0', 'note 1']);

      await controller.loadOlder();

      expect(contents(last(states))).toEqual(['note 0', 'note 1', 'note 2', 'note 3']);
    });

    it('walks back a page at a time to the end of the cache', async () => {
      const { controller, states } = await startPaged(notes(5));

      await controller.loadOlder();
      await controller.loadOlder();

      expect(contents(last(states))).toEqual(['note 0', 'note 1', 'note 2', 'note 3', 'note 4']);
      expect(last(states).exhausted).toBe(false);
    });

    it('keeps the boundary event once, not twice', async () => {
      // `until` is inclusive, so the cursor event is delivered again.
      const { controller, states } = await startPaged(notes(4));

      await controller.loadOlder();

      const ids = last(states).events.map((event) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps two events sharing a second, which a cursor of until-1 would skip', async () => {
      const events = [
        makeEvent({ id: 'a'.repeat(64), pubkey: AUTHOR, created_at: 200, content: 'newest' }),
        makeEvent({ id: 'b'.repeat(64), pubkey: AUTHOR, created_at: 100, content: 'tied one' }),
        makeEvent({ id: 'c'.repeat(64), pubkey: AUTHOR, created_at: 100, content: 'tied two' }),
      ];
      const { controller, states } = await startPaged(events, [
        { kinds: [1], authors: [AUTHOR], limit: 2 },
      ]);

      await controller.loadOlder();

      expect(contents(last(states)).sort()).toEqual(['newest', 'tied one', 'tied two']);
    });

    it('widens the page by what already sits on the cursor second', async () => {
      // Without this the boundary events spend a slot of every page: `until` is
      // inclusive, so the relay counts them against the limit and hands them
      // back to be dropped as duplicates.
      const fetchOnce = vi.spyOn(RelayConnection.prototype, 'fetchOnce');
      const events = [
        makeEvent({ id: 'a'.repeat(64), pubkey: AUTHOR, created_at: 200 }),
        makeEvent({ id: 'b'.repeat(64), pubkey: AUTHOR, created_at: 100 }),
        makeEvent({ id: 'c'.repeat(64), pubkey: AUTHOR, created_at: 100 }),
      ];
      const { controller } = await startPaged(events, [
        { kinds: [1], authors: [AUTHOR], limit: 3 },
      ]);

      await controller.loadOlder();

      expect(fetchOnce.mock.calls[0][0]).toEqual([
        { kinds: [1], authors: [AUTHOR], limit: 5, until: 100 },
      ]);
    });

    it('leaves out a filter whose since the cursor has already passed', async () => {
      // It could not match, and the relay would still forward it upstream — a
      // `since` puts a filter outside the freshness window.
      const fetchOnce = vi.spyOn(RelayConnection.prototype, 'fetchOnce');
      const events = [
        makeEvent({ id: 'a'.repeat(64), pubkey: AUTHOR, kind: 1, created_at: 200 }),
        makeEvent({ id: 'b'.repeat(64), pubkey: AUTHOR, kind: 1, created_at: 199 }),
        makeEvent({ id: 'c'.repeat(64), pubkey: AUTHOR, kind: 6, created_at: 100 }),
        makeEvent({ id: 'd'.repeat(64), pubkey: AUTHOR, kind: 6, created_at: 99 }),
      ];
      const { controller } = await startPaged(events, [
        { kinds: [1], authors: [AUTHOR], limit: 2, since: 150 },
        { kinds: [6], authors: [AUTHOR], limit: 2 },
      ]);

      await controller.loadOlder();

      expect(fetchOnce.mock.calls[0][0]).toEqual([
        { kinds: [6], authors: [AUTHOR], limit: 3, until: 99 },
      ]);
    });

    it('runs one page at a time, however often the end is reported', async () => {
      // The component's effect re-evaluates on every patch the controller makes
      // — a profile arriving, a validation verdict — so this is called far more
      // often than the reader scrolls.
      const { controller, states } = await startPaged(notes(6));
      let release: (events: NostrEvent[]) => void = () => {};
      const fetchOnce = vi.spyOn(RelayConnection.prototype, 'fetchOnce').mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );

      const first = controller.loadOlder();
      await controller.loadOlder();
      await controller.loadOlder();
      expect(fetchOnce).toHaveBeenCalledTimes(1);
      expect(last(states).loadingOlder).toBe(true);

      release([]);
      await first;

      expect(last(states).loadingOlder).toBe(false);
    });

    it('stops asking once a page brings nothing new', async () => {
      const { controller, states } = await startPaged(notes(3));

      await controller.loadOlder();
      expect(last(states).exhausted).toBe(false);
      await controller.loadOlder();
      expect(last(states).exhausted).toBe(true);

      const before = states.length;
      await controller.loadOlder();
      expect(states.length).toBe(before);
    });

    it('stays open when the socket went down instead of calling it the end', async () => {
      const { controller, states } = await startPaged(notes(4));
      vi.spyOn(RelayConnection.prototype, 'fetchOnce').mockResolvedValue([]);
      // Connected on the way in, gone by the time the empty answer is read.
      vi.spyOn(RelayConnection.prototype, 'isConnected', 'get')
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      await controller.loadOlder();

      expect(last(states).exhausted).toBe(false);
      expect(last(states).loadingOlder).toBe(false);
    });

    it('stops at the ceiling rather than evicting the page it just read', async () => {
      const { controller, states } = await startPaged(notes(10), undefined, { maxEvents: 4 });

      await controller.loadOlder();

      expect(last(states).events).toHaveLength(4);
      expect(last(states).capped).toBe(true);

      const before = states.length;
      await controller.loadOlder();
      expect(states.length).toBe(before);
    });

    it('classifies the page it appends, so its cards carry a badge too', async () => {
      const { controller, states } = await startPaged(notes(4));

      await controller.loadOlder();

      const state = last(states);
      expect([...state.origins.keys()].sort()).toEqual(
        state.events.map((event) => event.id).sort()
      );
    });

    it('asks for nothing before the first page has arrived', async () => {
      const dbName = `paging-${crypto.randomUUID()}`;
      await seedCache(dbName, notes(4));
      const states: TimelineState[] = [];
      const controller = new TimelineController({
        host: { dbName },
        onChange: (state) => states.push(state),
      });
      controllers.push(controller);

      // No `start`: there is no subscription, no cursor and no EOSE.
      await controller.loadOlder();

      expect(states).toEqual([]);
    });

    it('ends the timeline when the cursor passes a since bound', async () => {
      const events = notes(4);
      const { controller, states } = await startPaged(events, [
        { kinds: [1], authors: [AUTHOR], limit: 2, since: events[1].created_at },
      ]);

      await controller.loadOlder();

      expect(last(states).exhausted).toBe(true);
      expect(contents(last(states))).toEqual(['note 0', 'note 1']);
    });

    it('forgets the cursor and the paging state on a filter change', async () => {
      const { controller, states } = await startPaged(notes(4));
      await controller.loadOlder();
      await controller.loadOlder();
      expect(last(states).exhausted).toBe(true);

      controller.applyFilter([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);

      expect(last(states).exhausted).toBe(false);
      expect(last(states).capped).toBe(false);
      expect(last(states).events).toEqual([]);
    });

    it('opens no page while suspended', async () => {
      const { controller, states } = await startPaged(notes(5));
      controller.suspend();

      const before = states.length;
      await controller.loadOlder();

      expect(states.length).toBe(before);
    });

    it('abandons a page in flight when the controller is stopped', async () => {
      const { controller, states } = await startPaged(notes(5));

      const paging = controller.loadOlder();
      await controller.stop();
      await paging;

      // The page it had asked for never lands: nothing is appended after the
      // stop, on this snapshot or any that followed it.
      expect(states.every((state) => state.events.length <= 2)).toBe(true);
    });
  });

  /**
   * A filter source is the controller's only two-stage path: it issues a REQ of
   * its own to work out what the real REQ should be. What matters here is what
   * the controller does with the answer — above all, that "no filters" means no
   * subscription rather than a widened one.
   */
  describe('with a filter source', () => {
    it('subscribes with the filters the source resolved', async () => {
      const { controller } = createController();

      await controller.start(async () => [{ kinds: [1], limit: 7 }]);

      await waitFor(
        () => openSubscriptionIds(controller).includes(wireSubId('timeline-1')),
        'the resolved subscription'
      );
      const timeline = openSubscriptions(controller).find(
        (sub) => sub.id === wireSubId('timeline-1')
      );
      expect(timeline?.filters).toEqual([{ kinds: [1], limit: 7 }]);
    });

    it('opens no subscription at all when the source resolves to nothing', async () => {
      const { controller } = createController();

      await controller.start(async () => []);

      // The regression this exists for: a source that found no follow list must
      // not be turned into a filter the controller invented, because the only
      // filter it could invent is "the entire global feed".
      expect(openSubscriptionIds(controller)).toEqual([]);
    });

    it('gives the source a live connection to fetch with', async () => {
      const { controller } = createController();
      let connected: boolean | undefined;

      await controller.start(async ({ connection }) => {
        connected = connection.isConnected;
        return [];
      });

      // The source runs between connect and subscribe precisely so it can issue
      // a REQ of its own; a source handed a dead socket could not.
      expect(connected).toBe(true);
    });

    it('publishes what the source reports about its resolution', async () => {
      const { controller, states } = createController();

      await controller.start(async ({ setFollows }) => {
        setFollows({ status: 'resolving', count: 0, truncated: 0 });
        setFollows({ status: 'ready', count: 3, truncated: 1 });
        return [{ kinds: [1], limit: 10 }];
      });

      expect(states.at(-1)?.follows).toEqual({ status: 'ready', count: 3, truncated: 1 });
      expect(states.some((state) => state.follows?.status === 'resolving')).toBe(true);
    });

    it('tears the timeline down when the source reports an invalid list', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [makeEvent({ id: 'e1', pubkey: 'alice' })]);
      const { controller, states } = createController(dbName);
      let report: ((follows: FollowsState) => void) | undefined;

      await controller.start(async ({ setFollows }) => {
        report = setFollows;
        return [{ kinds: [1], limit: 10 }];
      });
      await waitFor(() => (states.at(-1)?.events.length ?? 0) === 1, 'the seeded event');

      report?.({ status: 'dropped', count: 2, truncated: 0 });

      // The event set was chosen by a list that turned out to be forged, so it
      // is dropped rather than left on screen — and the subscription that would
      // keep refilling it is closed.
      expect(states.at(-1)?.events).toEqual([]);
      expect(states.at(-1)?.follows?.status).toBe('dropped');
      await waitFor(
        () => !openSubscriptionIds(controller).includes(wireSubId('timeline-1')),
        'the subscription to close'
      );
    });

    it('reports a source that threw instead of subscribing to something else', async () => {
      const { controller, states } = createController();

      await controller.start(async () => {
        throw new Error('boom');
      });

      expect(states.at(-1)?.error).toContain('boom');
      expect(openSubscriptionIds(controller)).toEqual([]);
    });

    it('aborts the source when the controller is stopped mid-resolution', async () => {
      const { controller } = createController();
      let aborted: boolean | undefined;
      let entered = false;
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });

      // A source blocks for up to its own watchdog, and an attribute change
      // tears the widget's controller down without waiting for it.
      const started = controller.start(async ({ signal }) => {
        entered = true;
        await blocked;
        aborted = signal.aborted;
        return [{ kinds: [1], limit: 10 }];
      });
      await waitFor(() => entered, 'the source to start');
      await controller.stop();
      release?.();
      await started;

      expect(aborted).toBe(true);
      // Nothing is subscribed with a filter resolved after the teardown.
      expect(controller.host).toBeUndefined();
    });

    /**
     * The watch behind `follows.status === 'dropped'`, driven through the real
     * relay rather than by calling its callback directly.
     *
     * Every other spec around this stubs `watchValidation` or invokes
     * `setFollows` itself, which leaves the loop — the `pending` sighting, the
     * re-poll, the storage read — able to break without a single test noticing.
     * These drive `storage` and let the poller reach its own conclusion.
     */
    describe('validation watch', () => {
      /** Wait past enough poll intervals for the watch to reach a verdict. */
      const WATCH_TIMEOUT_MS = 5000;

      /** Fast enough that the misses are spent in well under a second. */
      const POLL_MS = 20;

      async function startWatch(
        dbName: string,
        eventId: string
      ): Promise<{ controller: TimelineController; dropped: () => boolean }> {
        const { controller } = createController(dbName, { validationPollIntervalMs: POLL_MS });
        let dropped = false;
        await controller.start(async ({ watchValidation }) => {
          watchValidation(eventId, () => {
            dropped = true;
          });
          return [{ kinds: [1], limit: 10 }];
        });
        return { controller, dropped: () => dropped };
      }

      it('reports an event the relay deleted after holding it', async () => {
        const dbName = `controller-${crypto.randomUUID()}`;
        // Stored and unvalidated — exactly the state a freshly ingested kind 3
        // is in while lazy validation has yet to reach it.
        await seedCache(dbName, [makeEvent({ id: 'follows-1', kind: 3, pubkey: 'alice' })], {
          validated: false,
        });
        const { dropped } = await startWatch(dbName, 'follows-1');

        // The watch has to see it `pending` first, so let a poll land before
        // taking it away; otherwise this would pass on the never-stored path.
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
        expect(dropped()).toBe(false);

        const host = await acquireRelayHost({ dbName });
        seeded.push(host);
        await host.storage.deleteEvent('follows-1');

        await waitFor(dropped, 'the deletion to be reported', WATCH_TIMEOUT_MS);
      });

      it('reports an event that never reaches storage at all', async () => {
        const dbName = `controller-${crypto.randomUUID()}`;
        const { dropped } = await startWatch(dbName, 'never-stored');

        // Waiting for a `pending` sighting before concluding anything would
        // look safer, but lazy validation runs every 5s and can delete a forged
        // event before the first poll — leaving `unknown` from the outset and a
        // timeline built on it running for the rest of the session.
        await waitFor(dropped, 'the absence to be reported', WATCH_TIMEOUT_MS);
      });

      it('stays quiet for an event the relay has validated', async () => {
        const dbName = `controller-${crypto.randomUUID()}`;
        await seedCache(dbName, [makeEvent({ id: 'follows-2', kind: 3, pubkey: 'alice' })]);

        const { dropped } = await startWatch(dbName, 'follows-2');

        // `validated` is terminal and is the question actually being asked:
        // the relay checked the signature and it held.
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
        expect(dropped()).toBe(false);
      });

      it('ends the watch when the controller is stopped', async () => {
        const dbName = `controller-${crypto.randomUUID()}`;
        const { controller, dropped } = await startWatch(dbName, 'never-stored');

        await controller.stop();
        // Long enough that the misses would have been exhausted had the watch
        // survived its controller.
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));

        expect(dropped()).toBe(false);
      });
    });

    it('re-arms the filter source after a suspend so the controller can resume', async () => {
      const { controller } = createController();

      await controller.start(async () => [{ kinds: [1], limit: 10 }]);
      controller.suspend();
      controller.applyFilter([{ kinds: [1], limit: 10 }]);

      // `suspend()` aborts the source's signal; reusing that same controller
      // afterwards would hand every later source a signal that is already spent,
      // so a resolution could never complete and its watch would be born dead.
      const abort = (controller as unknown as { filterSourceAbort: AbortController })
        .filterSourceAbort;

      expect(abort.signal.aborted).toBe(false);
    });

    it('drops the resolution state on suspend rather than stranding it', async () => {
      const { controller, states } = createController();

      await controller.start(async ({ setFollows }) => {
        setFollows({ status: 'resolving', count: 0, truncated: 0 });
        return [];
      });
      expect(states.at(-1)?.follows?.status).toBe('resolving');

      controller.suspend();

      // The source that was going to replace `resolving` is gone, so leaving it
      // there would strand the widget on "フォローリストを取得しています…".
      expect(states.at(-1)?.follows).toBeUndefined();
    });

    it('clears the resolution state when the source throws', async () => {
      const { controller, states } = createController();

      await controller.start(async ({ setFollows }) => {
        setFollows({ status: 'resolving', count: 0, truncated: 0 });
        throw new Error('boom');
      });

      expect(states.at(-1)?.error).toContain('boom');
      expect(states.at(-1)?.follows?.status).toBe('missing');
    });
  });

  describe('quoted events', () => {
    const QUOTED_ID = 'q'.repeat(64);

    /** The lookup a card asks for when it references QUOTED_ID. */
    const quotedTarget = {
      key: QUOTED_ID,
      filter: { ids: [QUOTED_ID] },
      replaceable: false,
    };

    /** Embed keys the controller has already started a lookup for. */
    function requestedEmbeds(controller: TimelineController): Set<string> {
      return lookups(controller).embeds.queue.requested;
    }

    it('resolves a quote out of the cache and looks its author up', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [
        makeEvent({ id: QUOTED_ID, pubkey: 'alice', content: 'the quoted note' }),
      ]);
      const { controller, states } = createController(dbName);
      await controller.start([{ kinds: [1], limit: 10 }]);

      controller.requestEmbed(quotedTarget);
      // Something to render while the REQ is in flight, rather than nothing.
      expect(states.at(-1)?.embeds.get(QUOTED_ID)).toEqual({ status: 'loading' });

      await waitFor(
        () => states.at(-1)?.embeds.get(QUOTED_ID)?.status === 'ready',
        'the quoted event'
      );
      expect(states.at(-1)?.embeds.get(QUOTED_ID)?.event?.content).toBe('the quoted note');
      // The nested card names its author, so the kind 0 has to be asked for too.
      // Read from the controller rather than the relay: a lookup with no grace
      // closes on EOSE, so the subscription is gone before this can see it.
      expect(lookups(controller).profiles.queue.requested.has('alice')).toBe(true);
    });

    it('reports a quote nothing answered for as missing', async () => {
      const { controller, states } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);

      controller.requestEmbed(quotedTarget);

      // Cache-only, and the event was never stored: "not published", "not
      // upstream" and "no answer" all come out the same way here.
      await waitFor(
        () => states.at(-1)?.embeds.get(QUOTED_ID)?.status === 'missing',
        'the missing verdict'
      );
    });

    it('asks for the same quote once however many cards reference it', async () => {
      const { controller } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);

      controller.requestEmbed(quotedTarget);
      controller.requestEmbed(quotedTarget);
      controller.requestEmbed(quotedTarget);

      expect(requestedEmbeds(controller).size).toBe(1);
    });

    it('holds the extra lookups back rather than opening one per reference', async () => {
      const { controller } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);

      for (let index = 0; index < 6; index++) {
        const key = `${index}`.repeat(64);
        controller.requestEmbed({ key, filter: { ids: [key] }, replaceable: false });
      }

      // The relay caps a client at 20 subscriptions and the timeline's own REQ
      // plus four profile lookups already share that budget.
      const { inFlight, queue } = lookups(controller).embeds;
      expect(inFlight).toBeLessThanOrEqual(2);
      expect(inFlight + queue.pending.length).toBe(6);
    });

    it('polls the relay for the quoted events verdicts too', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [makeEvent({ id: QUOTED_ID, pubkey: 'alice' })]);
      const { controller, states } = createController(dbName);
      // No timeline events at all: a card can be quoting something long before
      // the subscription it lives on has delivered anything.
      await controller.start([{ kinds: [9999], limit: 10 }]);
      controller.requestEmbed(quotedTarget);

      await waitFor(
        () => states.at(-1)?.validationStatuses.has(QUOTED_ID) === true,
        "the quoted event's verdict"
      );
    });

    it('refuses to start a lookup while suspended, and forgets the ones it had', async () => {
      const { controller } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);
      controller.requestEmbed(quotedTarget);

      controller.suspend();

      // A lookup running through a suspend would refill the very cache the demo
      // is about to measure cold.
      expect(requestedEmbeds(controller).size).toBe(0);
      controller.requestEmbed(quotedTarget);
      expect(requestedEmbeds(controller).size).toBe(0);
    });

    it('drops resolved quotes when the filters are replaced', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [makeEvent({ id: QUOTED_ID, pubkey: 'alice' })]);
      const { controller, states } = createController(dbName);
      await controller.start([{ kinds: [1], limit: 10 }]);
      controller.requestEmbed(quotedTarget);
      await waitFor(
        () => states.at(-1)?.embeds.get(QUOTED_ID)?.status === 'ready',
        'the quoted event'
      );

      controller.applyFilter([{ kinds: [1], limit: 5 }]);

      // They were keyed off bodies that are no longer on screen.
      expect(states.at(-1)?.embeds.size).toBe(0);
      // …and the new timeline must be able to ask for them again.
      expect(requestedEmbeds(controller).size).toBe(0);
    });

    it('lets a resumed controller ask again after a suspend', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [makeEvent({ id: QUOTED_ID, pubkey: 'alice' })]);
      const { controller, states } = createController(dbName);
      await controller.start([{ kinds: [1], limit: 10 }]);

      controller.suspend();
      controller.applyFilter([{ kinds: [1], limit: 10 }]);
      controller.requestEmbed(quotedTarget);

      // `suspend()` aborts the signal the lookups run under; reusing that same
      // controller afterwards would have every later lookup resolve instantly
      // with nothing and report a perfectly cached event as missing.
      await waitFor(
        () => states.at(-1)?.embeds.get(QUOTED_ID)?.status === 'ready',
        'the quoted event after resuming'
      );
    });
  });

  /**
   * The reaction subscription is the one thing the controller opens and never
   * closes on its own, so what is worth pinning down is the opposite of the
   * embed tests above: that exactly one is opened per post, that it outlives a
   * filter change, and that the two paths which *must* end it still do.
   */
  describe('reactions', () => {
    const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
    const OTHER_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';
    const target = parsePostTarget({ eventId: POST_ID });
    if (!target) {
      throw new Error('fixture post id should parse');
    }

    /** The reaction lookups currently open on the relay. */
    function reactionSubscriptions(
      controller: TimelineController
    ): { id: string; filters: Filter[] }[] {
      return openSubscriptions(controller).filter((sub) => sub.id.startsWith('reactions-'));
    }

    /** A kind 7 on the fixture post. */
    function reactionEvent(id: string, pubkey: string, content = '+'): NostrEvent {
      return makeEvent({ id, pubkey, kind: 7, content, tags: [['e', POST_ID]] });
    }

    it('asks the relay for the post kind 7 events that point at it', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReactions(target, 50);

      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');
      expect(reactionSubscriptions(controller)[0].filters).toEqual([
        { kinds: [7], '#e': [POST_ID], limit: 50 },
      ]);
    });

    it('asks with an `a` filter for an addressable post', async () => {
      const address = `30023:${'cc'.repeat(32)}:my-article`;
      const addressable = parsePostTarget({
        author: 'cc'.repeat(32),
        kind: '30023',
        identifier: 'my-article',
      });
      if (!addressable) {
        throw new Error('fixture coordinate should parse');
      }
      const { controller } = createController();
      await controller.start([addressable.filter]);

      controller.requestReactions(addressable, 10);

      // NIP-25 points at an addressable event with an `a` tag; asking with `#e`
      // would match nothing at all.
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');
      expect(reactionSubscriptions(controller)[0].filters).toEqual([
        { kinds: [7], '#a': [address], limit: 10 },
      ]);
    });

    it('opens one subscription however many times it is asked', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReactions(target);
      controller.requestReactions(target);
      controller.requestReactions(target);

      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');
      expect(reactionSubscriptions(controller)).toHaveLength(1);
    });

    it('collects the reactions the relay holds, and only those on this post', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [
        reactionEvent('r1', 'p1'),
        reactionEvent('r2', 'p2', '🔥'),
        // A reaction to a reply: NIP-10 keeps the root in the tags, so the
        // relay's `#e` filter delivers it — and NIP-25 says the last `e` tag is
        // the target, which is not us.
        makeEvent({
          id: 'r3',
          pubkey: 'p3',
          kind: 7,
          content: '+',
          tags: [
            ['e', POST_ID],
            ['e', OTHER_ID],
          ],
        }),
      ]);
      const { controller, states } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReactions(target);

      await waitFor(
        () => (states.at(-1)?.reactions.get(POST_ID)?.length ?? 0) >= 2,
        'the post reactions'
      );
      // Filtered here rather than in the view because the cap is here: under a
      // busy thread the reactions to replies would push out the real ones.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        states
          .at(-1)
          ?.reactions.get(POST_ID)
          ?.map((event) => event.id)
          .sort()
      ).toEqual(['r1', 'r2']);
    });

    it('keeps watching across a filter change', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReactions(target);
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');

      controller.applyFilter([{ kinds: [1], limit: 5 }]);

      // Unlike profiles and quoted events, reactions are not derived from what
      // is on screen — the caller named the post — so a new filter says nothing
      // about whether they are still wanted.
      expect(reactionSubscriptions(controller)).toHaveLength(1);
    });

    it('ends the subscription on suspend, so a cold benchmark stays cold', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReactions(target);
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');

      controller.suspend();

      await waitFor(
        () => reactionSubscriptions(controller).length === 0,
        'the reaction REQ to close'
      );
    });

    it('refuses to open one while suspended, and lets a resumed one ask again', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.suspend();
      controller.requestReactions(target);
      expect(reactionSubscriptions(controller)).toHaveLength(0);

      controller.applyFilter([{ ids: [POST_ID] }]);
      controller.requestReactions(target);
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');
    });

    it('lets the caller ask again after the relay closes the subscription', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReactions(target);
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');
      const firstSubId = reactionSubscriptions(controller)[0].id;

      // Driven through the connection's own handler rather than the relay: the
      // in-page relay only sends CLOSED in reply to a CLOSE we sent ourselves,
      // by which point `RelayConnection.unsubscribe` has already dropped the
      // handlers. This path exists for a relay that ends a REQ on its own.
      const connection = (controller as unknown as { connection: RelayConnection }).connection;
      const entry = (
        connection as unknown as {
          subscriptions: Map<string, { handlers: { onClosed?: (reason: string) => void } }>;
        }
      ).subscriptions.get(firstSubId);
      expect(entry).toBeDefined();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      entry?.handlers.onClosed?.('closed by the relay');

      // Without the de-duplication guard being released, the chips would sit at
      // whatever count they had reached until the element was rebuilt.
      controller.requestReactions(target);
      await waitFor(
        () => reactionSubscriptions(controller).some((sub) => sub.id !== firstSubId),
        'a replacement reaction REQ'
      );
    });

    it('ends the subscription on stop', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReactions(target);
      await waitFor(() => reactionSubscriptions(controller).length === 1, 'the reaction REQ');

      const relay = controller.host;
      await controller.stop();

      // Read off the relay directly: `controller.host` is cleared by stop().
      const subscriptions = (
        relay?.relay as unknown as {
          subscriptionManager: { getAllSubscriptions(): { id: string }[] };
        }
      ).subscriptionManager.getAllSubscriptions();
      expect(subscriptions.filter((sub) => sub.id.startsWith('reactions-'))).toHaveLength(0);
    });
  });

  describe('replies', () => {
    const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
    const REPLY_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';
    const GRANDCHILD_ID = 'cc00000000000000000000000000000000000000000000000000000000000003';
    const ELSEWHERE_ID = 'dd00000000000000000000000000000000000000000000000000000000000004';
    const target = parsePostTarget({ eventId: POST_ID });
    if (!target) {
      throw new Error('fixture post id should parse');
    }

    /** The thread lookups currently open on the relay, oldest level first. */
    function replySubscriptions(
      controller: TimelineController
    ): { id: string; filters: Filter[] }[] {
      return openSubscriptions(controller).filter((sub) => sub.id.startsWith('replies-'));
    }

    function repliesOf(states: TimelineState[]): string[] {
      return (states.at(-1)?.replies.get(POST_ID) ?? []).map((event) => event.id).sort();
    }

    /** A NIP-10 reply in the marked form. */
    function replyEvent(id: string, parent: string): NostrEvent {
      return makeEvent({
        id,
        pubkey: `p${id}`,
        tags:
          parent === POST_ID
            ? [['e', POST_ID, '', 'root']]
            : [
                ['e', POST_ID, '', 'root'],
                ['e', parent, '', 'reply'],
              ],
      });
    }

    it('asks the relay for the kind 1 events replying to the post', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target, { limit: 50 });

      await waitFor(() => replySubscriptions(controller).length === 1, 'the level 1 REQ');
      expect(replySubscriptions(controller)[0].filters).toEqual([
        { kinds: [1], '#e': [POST_ID], limit: 50 },
      ]);
    });

    it('asks with an `a` filter for an addressable post', async () => {
      const address = `30023:${'cc'.repeat(32)}:my-article`;
      const addressable = parsePostTarget({
        author: 'cc'.repeat(32),
        kind: '30023',
        identifier: 'my-article',
      });
      if (!addressable) {
        throw new Error('fixture coordinate should parse');
      }
      const { controller } = createController();
      await controller.start([addressable.filter]);

      controller.requestReplies(addressable, { limit: 10 });

      await waitFor(() => replySubscriptions(controller).length === 1, 'the level 1 REQ');
      expect(replySubscriptions(controller)[0].filters).toEqual([
        { kinds: [1], '#a': [address], limit: 10 },
      ]);
    });

    it('opens the next level with the ids the level above delivered', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [replyEvent(REPLY_ID, POST_ID)]);
      const { controller } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target, { limit: 20, maxDepth: 3 });

      // NIP-10 lets a grandchild name only its own parent and the thread root,
      // so this second REQ is the only thing that can reach one.
      await waitFor(() => replySubscriptions(controller).length === 2, 'the level 2 REQ');
      expect(replySubscriptions(controller)[1].filters).toEqual([
        { kinds: [1], '#e': [REPLY_ID], limit: 20 },
      ]);
    });

    it('stops opening levels at maxDepth', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [replyEvent(REPLY_ID, POST_ID), replyEvent(GRANDCHILD_ID, REPLY_ID)]);
      const { controller, states } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target, { maxDepth: 2 });

      await waitFor(() => repliesOf(states).length === 2, 'both replies');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replySubscriptions(controller)).toHaveLength(2);
    });

    it('opens no further level when one comes back empty', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target, { maxDepth: 3 });

      await waitFor(() => replySubscriptions(controller).length === 1, 'the level 1 REQ');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replySubscriptions(controller)).toHaveLength(1);
    });

    it('opens one thread however many times it is asked', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target);
      controller.requestReplies(target);

      await waitFor(() => replySubscriptions(controller).length === 1, 'the level 1 REQ');
      expect(replySubscriptions(controller)).toHaveLength(1);
    });

    it('keeps the replies to this post and drops what the #e match dragged in', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [
        replyEvent(REPLY_ID, POST_ID),
        // A reaction and a mention, both delivered by the same `#e` filter.
        makeEvent({ id: 'r1', pubkey: 'p1', kind: 7, content: '+', tags: [['e', POST_ID]] }),
        makeEvent({
          id: ELSEWHERE_ID,
          pubkey: 'p2',
          tags: [['e', POST_ID, '', 'mention']],
        }),
      ]);
      const { controller, states } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target);

      await waitFor(() => repliesOf(states).length >= 1, 'the reply');
      // Filtered on delivery rather than in the view because the cap is here:
      // under a busy thread the other branches would push out the real replies.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(repliesOf(states)).toEqual([REPLY_ID]);
    });

    it('refuses an answer to something else that claims this post as its root', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [
        replyEvent(REPLY_ID, POST_ID),
        // Anyone can write this, and the relay's `#e` delivers it. Ungated,
        // enough of them push the real replies out of MAX_REPLIES — and
        // `insertEvent` drops the oldest, so fresh timestamps decide.
        makeEvent({
          id: ELSEWHERE_ID,
          pubkey: 'spam',
          created_at: 1_900_000_000,
          tags: [
            ['e', POST_ID, '', 'root'],
            ['e', GRANDCHILD_ID, '', 'reply'],
          ],
        }),
      ]);
      const { controller, states } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target, { maxDepth: 1 });

      await waitFor(() => repliesOf(states).length >= 1, 'the reply');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(repliesOf(states)).toEqual([REPLY_ID]);
    });

    it('asks the relay to vouch for the replies, not only the post', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [replyEvent(REPLY_ID, POST_ID)]);
      const { controller, states } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);

      controller.requestReplies(target);

      // Without the reply ids in the poll, every card in the thread would stay
      // dimmed for as long as the widget was open.
      await waitFor(
        () => states.at(-1)?.validationStatuses.get(REPLY_ID) === 'validated',
        'the reply verdict'
      );
    });

    it('ends every level on suspend, so a cold benchmark stays cold', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [replyEvent(REPLY_ID, POST_ID)]);
      const { controller } = createController(dbName);
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReplies(target);
      await waitFor(() => replySubscriptions(controller).length === 2, 'both levels');

      controller.suspend();

      await waitFor(() => replySubscriptions(controller).length === 0, 'the levels to close');
    });

    it('ends every level on stop', async () => {
      const { controller } = createController();
      await controller.start([{ ids: [POST_ID] }]);
      controller.requestReplies(target);
      await waitFor(() => replySubscriptions(controller).length === 1, 'the level 1 REQ');

      const relay = controller.host;
      await controller.stop();

      const subscriptions = (
        relay?.relay as unknown as {
          subscriptionManager: { getAllSubscriptions(): { id: string }[] };
        }
      ).subscriptionManager.getAllSubscriptions();
      expect(subscriptions.filter((sub) => sub.id.startsWith('replies-'))).toHaveLength(0);
    });
  });

  describe('showPost', () => {
    const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
    const PARENT_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';
    const post = parsePostTarget({ eventId: POST_ID });
    const parent = parsePostTarget({ eventId: PARENT_ID });
    if (!post || !parent) {
      throw new Error('fixture post ids should parse');
    }

    function postSubscriptions(controller: TimelineController): string[] {
      return openSubscriptionIds(controller).filter(
        (id) => id.startsWith('replies-') || id.startsWith('reactions-')
      );
    }

    it('moves the watches to the new post rather than adding to them', async () => {
      const { controller } = createController();
      await controller.start([post.filter]);
      controller.requestReactions(post);
      controller.requestReplies(post);
      await waitFor(() => postSubscriptions(controller).length === 2, 'the first post watches');
      const before = postSubscriptions(controller);

      controller.showPost(parent, { reactions: { limit: 50 }, replies: { maxDepth: 2 } });

      // Left open, these would accumulate two per hop and put a reader a few
      // steps up a thread over the relay's per-client cap of 20.
      await waitFor(
        () => postSubscriptions(controller).every((id) => !before.includes(id)),
        'the old watches to close'
      );
      await waitFor(() => postSubscriptions(controller).length === 2, 'the new post watches');
      expect(
        openSubscriptions(controller).find((sub) => sub.id.startsWith('replies-'))?.filters
      ).toEqual([{ kinds: [1], '#e': [PARENT_ID], limit: 100 }]);
    });

    it('stays inside the relay budget however far a reader walks up a thread', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      // A chain of replies, each the parent of the next, so every hop opens a
      // level 2 as well as its own level 1.
      const chain = Array.from(
        { length: 8 },
        (_, index) => `ee${String(index).padStart(2, '0')}${'0'.repeat(60)}`
      );
      await seedCache(
        dbName,
        chain.flatMap((id, index) => [
          makeEvent({ id, pubkey: 'p1', content: `post ${index}` }),
          // A reply to it, so the thread has a second level to open.
          makeEvent({
            id: `ff${String(index).padStart(2, '0')}${'0'.repeat(60)}`,
            pubkey: 'p2',
            tags: [['e', id, '', 'root']],
          }),
        ])
      );
      const { controller } = createController(dbName);
      const first = parsePostTarget({ eventId: chain[0] });
      if (!first) {
        throw new Error('fixture post id should parse');
      }
      await controller.start([first.filter]);
      controller.requestReactions(first);
      controller.requestReplies(first);

      for (const id of chain.slice(1)) {
        const next = parsePostTarget({ eventId: id });
        if (!next) {
          throw new Error('fixture post id should parse');
        }
        controller.showPost(next, { reactions: { limit: 50 }, replies: { maxDepth: 3 } });
        await waitFor(() => postSubscriptions(controller).length >= 2, `the watches for ${id}`);
      }

      // The relay allows one client 20. Eight hops leaking two apiece would be
      // well past it, and the failure mode is a REQ the relay simply refuses.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(openSubscriptionIds(controller).length).toBeLessThanOrEqual(20);
      expect(postSubscriptions(controller).length).toBeLessThanOrEqual(4);
    });

    it('drops what the old post had collected', async () => {
      const dbName = `controller-${crypto.randomUUID()}`;
      await seedCache(dbName, [
        makeEvent({ id: 'r1', pubkey: 'p1', kind: 7, content: '+', tags: [['e', POST_ID]] }),
      ]);
      const { controller, states } = createController(dbName);
      await controller.start([post.filter]);
      controller.requestReactions(post);
      await waitFor(() => (states.at(-1)?.reactions.get(POST_ID)?.length ?? 0) === 1, 'a reaction');

      controller.showPost(parent, { reactions: { limit: 50 } });

      // Kept per post rather than blanked, the map would grow with every hop.
      expect(states.at(-1)?.reactions.has(POST_ID)).toBe(false);
    });
  });

  describe('startPost', () => {
    const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000003';
    const post = parsePostTarget({ eventId: POST_ID });
    if (!post) {
      throw new Error('fixture post id should parse');
    }

    it('asks for the post itself before the watches around it', async () => {
      const { controller } = createController();

      await controller.startPost(post, { reactions: { limit: 50 }, replies: { maxDepth: 3 } });

      await waitFor(() => openSubscriptionIds(controller).length === 3, 'all three subscriptions');
      // The order is the assertion: what the reader is waiting to see is the
      // post, and the watches' reads grow with how much the post was answered.
      expect(openSubscriptionIds(controller)).toEqual(
        ['timeline-1', 'reactions-1', 'replies-1'].map(wireSubId)
      );
    });

    it('opens the same watches showPost would', async () => {
      const { controller } = createController();

      await controller.startPost(post, { reactions: { limit: 50 }, replies: { limit: 20 } });

      await waitFor(() => openSubscriptionIds(controller).length === 3, 'all three subscriptions');
      const subscriptions = openSubscriptions(controller);
      expect(subscriptions.find((sub) => sub.id.startsWith('reactions-'))?.filters).toEqual([
        { kinds: [7], '#e': [POST_ID], limit: 50 },
      ]);
      expect(subscriptions.find((sub) => sub.id.startsWith('replies-'))?.filters).toEqual([
        { kinds: [1], '#e': [POST_ID], limit: 20 },
      ]);
    });

    it('opens no watch the caller did not ask for', async () => {
      const { controller } = createController();

      await controller.startPost(post, {});

      await waitFor(() => openSubscriptionIds(controller).length > 0, 'the post subscription');
      expect(openSubscriptionIds(controller)).toEqual([wireSubId('timeline-1')]);
    });

    it('opens no watch for a post it was re-pointed away from while booting', async () => {
      const other = parsePostTarget({
        eventId: 'aa00000000000000000000000000000000000000000000000000000000000004',
      });
      if (!other) {
        throw new Error('fixture post id should parse');
      }
      const { controller } = createController();

      // Deliberately not awaited: the window this closes is the relay boot, and
      // a page setting `event-id` from script lands inside it.
      const booting = controller.startPost(post, { reactions: {}, replies: {} });
      controller.showPost(other, { reactions: {}, replies: {} });
      await booting;

      // Left to open, the superseded boot's pair would run on with nothing to
      // close them: `showPost` had already closed the watches it knew about.
      await waitFor(
        () => openSubscriptionIds(controller).some((id) => id.startsWith('reactions-')),
        "the new post's watches"
      );
      const filters = openSubscriptions(controller)
        .filter((sub) => sub.id.startsWith('reactions-') || sub.id.startsWith('replies-'))
        .flatMap((sub) => sub.filters);
      expect(filters).toHaveLength(2);
      expect(JSON.stringify(filters)).not.toContain(POST_ID);
    });
  });

  /**
   * A widget re-renders once per emit, so each path is pinned to the number of
   * snapshots it publishes, in order, and the keys each one touches.
   */
  describe('published snapshots', () => {
    const POST_ID = 'cc00000000000000000000000000000000000000000000000000000000000001';
    const OTHER_ID = 'cc00000000000000000000000000000000000000000000000000000000000002';

    /** Changed by identity — the contract views rely on to re-run a `$derived`. */
    function changesSince(states: TimelineState[], from: number): (keyof TimelineState)[][] {
      return states.slice(from).map((state, index) => {
        const previous = states[from + index - 1];
        return (Object.keys(state) as (keyof TimelineState)[])
          .filter((key) => state[key] !== previous?.[key])
          .sort();
      });
    }

    it('publishes one snapshot for a suspend, however many lookups it closes', async () => {
      const { controller, states } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);
      const before = states.length;

      controller.suspend();

      // Closing four sets of lookups must not emit four times. Nothing changes
      // in that snapshot: `follows` is only ever set by a filter source.
      expect(changesSince(states, before)).toEqual([[]]);
      expect(states.at(-1)?.follows).toBeUndefined();
    });

    it('publishes one snapshot for a filter change, clearing the timeline in it', async () => {
      const { controller, states } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);
      const before = states.length;

      controller.applyFilter([{ kinds: [1], limit: 5 }]);

      // `embeds` is dropped in the same snapshot, not one of the loader's own.
      expect(changesSince(states, before)).toEqual([
        ['embeds', 'events', 'origins', 'validationStatuses'],
      ]);
    });

    it('publishes two snapshots for a showPost: the new filter, then the post-scoped state', async () => {
      const post = parsePostTarget({ eventId: POST_ID });
      const other = parsePostTarget({ eventId: OTHER_ID });
      if (!post || !other) {
        throw new Error('fixture targets should parse');
      }
      const { controller, states } = createController();
      await controller.startPost(post, { reactions: {}, replies: {} });
      const before = states.length;

      controller.showPost(other, { reactions: {}, replies: {} });

      expect(changesSince(states, before)).toEqual([
        ['embeds', 'events', 'origins', 'validationStatuses'],
        ['reactions', 'replies'],
      ]);
    });

    it('publishes only the dropped connection for a stop', async () => {
      const { controller, states } = createController();
      await controller.start([{ kinds: [1], limit: 10 }]);
      const before = states.length;

      await controller.stop();

      // The lookups a stop tears down publish nothing of their own.
      expect(changesSince(states, before)).toEqual([['status']]);
      expect(states.at(-1)?.status).toBe('disconnected');
    });
  });

  /**
   * A REQ is answered cache-first and upstream-second, each side stopping at
   * the REQ's own `limit`. What these pin down is the case where the two
   * answers no longer meet — the reader left the page alone long enough for
   * upstream's newest `limit` events to all be new — which used to render as a
   * fresh block, a jump of however long they were away, and then whatever the
   * cache still held.
   */
  describe('an answer that does not reach the cache', () => {
    const AUTHOR = 'b'.repeat(64);
    const UPSTREAM = 'wss://upstream.example';

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function note(id: string, createdAt: number): NostrEvent {
      return makeEvent({
        id: id.padStart(64, 'f'),
        pubkey: AUTHOR,
        created_at: createdAt,
        content: id,
      });
    }

    function contents(state: TimelineState): string[] {
      return state.events.map((event) => event.content);
    }

    /**
     * Start a controller whose timeline subscription is fed by hand.
     *
     * The widget's relay is cache-only in these specs, so the upstream half of
     * an answer has to be played rather than fetched: an event is delivered
     * upstream-side by recording the sighting the metrics classify it by, the
     * same order the read-through path produces it in.
     */
    async function startFed(filters: Filter[]) {
      const states: TimelineState[] = [];
      const controller = new TimelineController({
        host: { dbName: `coverage-${crypto.randomUUID()}` },
        onChange: (state) => states.push(state),
      });
      controllers.push(controller);
      let handlers: SubscriptionHandlers | undefined;
      vi.spyOn(RelayConnection.prototype, 'subscribe').mockImplementation(
        (_subId, _filters, given) => {
          handlers = given;
        }
      );
      await controller.start(filters);
      if (!handlers) {
        throw new Error('the controller should have opened a subscription');
      }
      const opened = handlers;

      return {
        controller,
        states,
        deliver(events: NostrEvent[], origin: 'cache' | 'upstream' = 'cache'): void {
          for (const event of events) {
            if (origin === 'upstream') {
              controller.host?.metrics.recordUpstreamEvent(event.id, UPSTREAM);
            }
            opened.onEvent(event);
          }
        },
        eose(): void {
          opened.onEose?.();
        },
        /** What a reconnect looks like from here: rx-nostr re-sends the REQ. */
        reconnect(): void {
          const connection = (controller as unknown as { connection: RelayConnection }).connection;
          const options = (connection as unknown as { options: RelayConnectionOptions }).options;
          options.onStatusChange?.('connected');
        },
      };
    }

    it('leaves out the older block the answer stopped short of', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);

      // What the cache had from the reader's last visit, and what upstream
      // answers with today — two blocks with a day between them.
      fed.deliver([note('old-1', 1_700_000_000), note('old-2', 1_699_999_999)]);
      fed.deliver([note('new-1', 1_700_086_400), note('new-2', 1_700_086_399)], 'upstream');
      fed.eose();

      expect(contents(fed.states[fed.states.length - 1])).toEqual(['new-1', 'new-2']);
    });

    it('keeps the older block when the answer came back short of the limit', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);

      fed.deliver([note('old-1', 1_700_000_000), note('old-2', 1_699_999_999)]);
      // One event, under a limit of two: upstream sent everything it had, so
      // there is nothing missing between it and the cache's block.
      fed.deliver([note('new-1', 1_700_086_400)], 'upstream');
      fed.eose();

      expect(contents(fed.states[fed.states.length - 1])).toEqual(['new-1', 'old-1', 'old-2']);
    });

    it('keeps everything when nothing came from upstream', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);

      // A cache-only relay: no answer to vouch for anything, and none needed.
      fed.deliver([note('old-1', 1_700_000_000), note('old-2', 1_699_999_999)]);
      fed.eose();

      expect(contents(fed.states[fed.states.length - 1])).toEqual(['old-1', 'old-2']);
    });

    it('leaves out what a re-sent REQ no longer reaches back to', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);
      fed.deliver([note('read-1', 1_700_000_000), note('read-2', 1_699_999_999)], 'upstream');
      fed.eose();
      expect(contents(fed.states[fed.states.length - 1])).toEqual(['read-1', 'read-2']);

      // The page sat open for a day; the socket came back and the REQ with it.
      fed.reconnect();
      fed.deliver([note('new-1', 1_700_086_400), note('new-2', 1_700_086_399)], 'upstream');
      fed.eose();

      // The events read a day ago are what the jump would be rendered under.
      expect(contents(fed.states[fed.states.length - 1])).toEqual(['new-1', 'new-2']);
    });

    it('lets paging read the left-out block back', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);
      fed.deliver([note('old-1', 1_700_000_000)]);
      fed.deliver([note('new-1', 1_700_086_400), note('new-2', 1_700_086_399)], 'upstream');
      fed.eose();
      expect(fed.states[fed.states.length - 1].exhausted).toBe(false);

      vi.spyOn(RelayConnection.prototype, 'fetchOnce').mockResolvedValue([
        note('gap-1', 1_700_086_398),
        note('old-1', 1_700_000_000),
      ]);
      await fed.controller.loadOlder();

      expect(contents(fed.states[fed.states.length - 1])).toEqual([
        'new-1',
        'new-2',
        'gap-1',
        'old-1',
      ]);
    });

    it('cuts a page that stops short of its own older block', async () => {
      const fed = await startFed([{ kinds: [1], authors: [AUTHOR], limit: 2 }]);
      fed.deliver([note('new-1', 1_700_086_400), note('new-2', 1_700_086_399)], 'upstream');
      fed.eose();

      // The page is widened by the event sitting on the cursor second, so its
      // answer is cut off at three — and whatever the cache still holds below
      // `gap-3` is behind another jump.
      const page = [
        note('gap-1', 1_700_086_398),
        note('gap-2', 1_700_086_397),
        note('gap-3', 1_700_086_396),
        note('old-1', 1_700_000_000),
      ];
      for (const event of page.slice(0, 3)) {
        fed.controller.host?.metrics.recordUpstreamEvent(event.id, UPSTREAM);
      }
      vi.spyOn(RelayConnection.prototype, 'fetchOnce').mockResolvedValue(page);
      await fed.controller.loadOlder();

      expect(contents(fed.states[fed.states.length - 1])).toEqual([
        'new-1',
        'new-2',
        'gap-1',
        'gap-2',
        'gap-3',
      ]);
    });
  });
});
