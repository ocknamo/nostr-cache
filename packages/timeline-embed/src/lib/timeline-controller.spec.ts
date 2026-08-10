// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
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

  /**
   * Lookups holding one of the controller's in-flight slots.
   *
   * Read from the controller rather than the relay because that is the budget
   * under test, and because it is taken synchronously — rx-nostr dispatches the
   * REQ itself a microtask later, through a queue that consults NIP-11 limits.
   */
  function inFlightProfiles(controller: TimelineController): number {
    return (controller as unknown as { profileSubs: Map<string, unknown> }).profileSubs.size;
  }

  /**
   * Put events straight into the cache the controller will read from.
   *
   * Acquiring the host up front means the controller (configured with the same
   * db name) joins the very same relay instead of starting a second one.
   */
  async function seedCache(dbName: string, events: NostrEvent[]): Promise<void> {
    const host = await acquireRelayHost({ dbName });
    seeded.push(host);
    for (const event of events) {
      await host.storage.saveEvent(event);
    }
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
        await seedCache(dbName, [makeEvent({ id: 'follows-1', kind: 3, pubkey: 'alice' })]);
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
        const host = await acquireRelayHost({ dbName });
        seeded.push(host);
        await host.storage.markValidated(['follows-2']);

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
      return (controller as unknown as { requestedEmbeds: Set<string> }).requestedEmbeds;
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
      const requestedProfiles = (controller as unknown as { requestedProfiles: Set<string> })
        .requestedProfiles;
      expect(requestedProfiles.has('alice')).toBe(true);
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
});
