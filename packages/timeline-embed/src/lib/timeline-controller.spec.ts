// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { getRelayHostRefCount } from './relay-host.ts';
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
  const originalWebSocket = globalThis.WebSocket;

  function createController(): { controller: TimelineController; states: TimelineState[] } {
    const states: TimelineState[] = [];
    const controller = new TimelineController({
      host: { dbName: `controller-${crypto.randomUUID()}` },
      onChange: (state) => states.push(state),
    });
    controllers.push(controller);
    return { controller, states };
  }

  /** The ids of subscriptions the controller currently has open on the relay. */
  function openSubscriptions(controller: TimelineController): string[] {
    const relay = controller.host?.relay as unknown as {
      subscriptionManager: { getAllSubscriptions(): { id: string }[] };
    };
    return relay.subscriptionManager.getAllSubscriptions().map((subscription) => subscription.id);
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
    expect(openSubscriptions(controller)).toContain('timeline-1');
    expect(openSubscriptions(controller).some((id) => id.startsWith('profiles-'))).toBe(false);
  });

  it('closes the timeline subscription on suspend', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });
    expect(openSubscriptions(controller)).toContain('timeline-1');

    controller.suspend();

    await waitFor(
      () => !openSubscriptions(controller).includes('timeline-1'),
      'the timeline subscription to close'
    );
    // A profile subscription surviving here would keep reading through to
    // upstream and refill the cache the caller is about to measure cold.
    expect(openSubscriptions(controller).some((id) => id.startsWith('profiles-'))).toBe(false);
  });

  it('replaces the subscription on applyFilter instead of accumulating them', async () => {
    const { controller } = createController();
    await controller.start({ kinds: [1], limit: 10 });

    controller.applyFilter({ kinds: [1], limit: 5 });

    await waitFor(
      () => openSubscriptions(controller).includes('timeline-2'),
      'the replacement subscription'
    );
    expect(openSubscriptions(controller)).not.toContain('timeline-1');
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
