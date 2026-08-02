// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import { type RelayHost, acquireRelayHost, getRelayHostRefCount } from './relay-host.ts';
import { TimelineController, type TimelineState } from './timeline-controller.ts';

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

  function createController(dbName = `controller-${crypto.randomUUID()}`): {
    controller: TimelineController;
    states: TimelineState[];
  } {
    const states: TimelineState[] = [];
    const controller = new TimelineController({
      host: { dbName },
      onChange: (state) => states.push(state),
    });
    controllers.push(controller);
    return { controller, states };
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

  /** The profile subscription, if one is open. */
  function profileSubscription(
    controller: TimelineController
  ): { id: string; filters: Filter[] } | undefined {
    return openSubscriptions(controller).find((sub) => sub.id.startsWith('profiles-'));
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

  async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
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
    await controller.start({ kinds: [1], limit: 10 });

    // Consumers destructure this before any kind 0 has arrived, so it has to be
    // a Map from the start rather than undefined.
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.profiles).toBeInstanceOf(Map);
    }
  });

  it('opens no profile subscription while the timeline has no authors', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });

    // Cache-only and empty, so no event — and therefore no author — is ever
    // seen. Asking for kind 0 anyway would be a REQ with an empty author list.
    expect(openSubscriptionIds(controller)).toContain('timeline-1');
    expect(profileSubscription(controller)).toBeUndefined();
  });

  it('closes the timeline subscription on suspend', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });
    expect(openSubscriptionIds(controller)).toContain('timeline-1');

    controller.suspend();

    await waitFor(
      () => !openSubscriptionIds(controller).includes('timeline-1'),
      'the timeline subscription to close'
    );
    // A profile subscription surviving here would keep reading through to
    // upstream and refill the cache the caller is about to measure cold.
    expect(profileSubscription(controller)).toBeUndefined();
  });

  it('replaces the subscription on applyFilter instead of accumulating them', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });

    controller.applyFilter({ kinds: [1], limit: 5 });

    await waitFor(
      () => openSubscriptionIds(controller).includes('timeline-2'),
      'the replacement subscription'
    );
    expect(openSubscriptionIds(controller)).not.toContain('timeline-1');
  });

  it('keeps profiles across a filter change so authors do not flicker', async () => {
    const { controller, states } = createController();
    await controller.start({ kinds: [1], limit: 10 });
    const before = states.at(-1)?.profiles;

    controller.applyFilter({ kinds: [1], limit: 5 });

    // Events and origins are cleared for the new subscription; profiles are
    // deliberately not, because re-fetching them would blank every author name.
    const after = states.at(-1);
    expect(after?.events).toEqual([]);
    expect(after?.profiles).toEqual(before);
  });

  it('asks for the profiles of the authors it displayed, in one REQ', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'alice', created_at: 1_700_000_100 }),
      makeEvent({ id: 'e2', pubkey: 'bob', created_at: 1_700_000_200 }),
      makeEvent({ id: 'e3', pubkey: 'alice', created_at: 1_700_000_300 }),
    ]);
    const { controller } = createController(dbName);

    await controller.start({ kinds: [1], limit: 10 });
    await waitFor(() => profileSubscription(controller) !== undefined, 'the profile subscription');

    const subscription = profileSubscription(controller);
    // Three events, two authors, one REQ — the debounce coalesces the burst and
    // an author is never named twice.
    expect(subscription?.filters).toHaveLength(1);
    expect(subscription?.filters[0].kinds).toEqual([0]);
    expect([...(subscription?.filters[0].authors ?? [])].sort()).toEqual(['alice', 'bob']);
  });

  it('renders a delivered profile and ignores an older copy of it', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      makeEvent({ id: 'e1', pubkey: 'alice', created_at: 1_700_000_100 }),
      makeEvent({
        id: 'p1',
        pubkey: 'alice',
        kind: 0,
        created_at: 1_700_000_500,
        content: JSON.stringify({ name: 'alice' }),
      }),
    ]);
    const { controller, states } = createController(dbName);

    await controller.start({ kinds: [1], limit: 10 });
    await waitFor(
      () => states.at(-1)?.profiles.get('alice') !== undefined,
      "alice's profile to arrive"
    );

    expect(states.at(-1)?.profiles.get('alice')).toEqual({ name: 'alice' });
  });

  it('closes the profile subscription on stop', async () => {
    const dbName = `controller-${crypto.randomUUID()}`;
    await seedCache(dbName, [makeEvent({ id: 'e1', pubkey: 'alice' })]);
    const { controller } = createController(dbName);
    await controller.start({ kinds: [1], limit: 10 });
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
    await controller.start({ kinds: [1], limit: 10 });
    expect(getRelayHostRefCount()).toBe(1);

    await controller.stop();

    expect(getRelayHostRefCount()).toBe(0);
    expect(controller.host).toBeUndefined();
  });

  it('is safe to stop twice', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });

    await controller.stop();
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(getRelayHostRefCount()).toBe(0);
  });
});
