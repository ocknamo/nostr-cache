// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the relay host boots on.
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as relayHost from './lib/relay-host.ts';

/**
 * The packaging contract of the embed bundle, as seen by a page that loads
 * `nostr-timeline.js` and reaches for `globalThis.NostrTimelineEmbed`.
 *
 * Two halves that pull against each other are checked here. The entry point
 * registers its custom elements by side effect, and it also re-exports the
 * relay API so a page can run the cache with no widget on it — a Nostr client
 * pointed at `interceptUrl` then reads through the same IndexedDB cache. Adding
 * the second must not cost the first: a tree-shaken re-export that dropped the
 * `.svelte` side-effect imports would leave `<nostr-timeline>` undefined, and
 * nothing else in the suite loads this file the way the bundle does.
 *
 * `import * as` rather than named imports on purpose — the assertions are about
 * what the module namespace carries, which is exactly what the IIFE global is.
 * For the same reason the components are never imported statically here: doing
 * so would register the elements on the entry point's behalf, and the
 * registration assertions below would pass with the side-effect imports gone.
 */
describe('embed entry point', () => {
  const originalWebSocket = globalThis.WebSocket;
  let entry: typeof import('./embed-entry.ts');
  let registered: { timeline: boolean; followTimeline: boolean; post: boolean };

  beforeAll(async () => {
    // Importing for the side effect is exactly how the embed bundle registers.
    entry = await import('./embed-entry.ts');
    // Snapshotted here, before any test can pull a component in on its own, so
    // what is asserted is what *this* import defined.
    registered = {
      timeline: Boolean(customElements.get('nostr-timeline')),
      followTimeline: Boolean(customElements.get('nostr-follow-timeline')),
      post: Boolean(customElements.get('nostr-post')),
    };
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await waitFor(() => relayHost.getRelayHostRefCount() === 0, 'the relay host to be released');
    globalThis.WebSocket = originalWebSocket;
  });

  it('registers every custom element', () => {
    expect(registered).toEqual({ timeline: true, followTimeline: true, post: true });
  });

  it('keeps the timeline component as the default export', async () => {
    // Imported dynamically, after the snapshot above was taken.
    const { default: NostrTimeline } = await import('./nostr-timeline.svelte');
    // Not `customElements.get('nostr-timeline')`: Svelte registers a generated
    // wrapper class around the component, so the two are deliberately not the
    // same object. What matters is that the default export did not become
    // something else when the named exports arrived beside it.
    expect(entry.default).toBe(NostrTimeline);
  });

  it('publishes the relay API the widgets use', () => {
    // Identity, not just presence: re-exporting a copy would hand callers a
    // second module instance with its own singleton, and the "one relay per
    // page" guarantee would quietly become two.
    expect(entry.acquireRelayHost).toBe(relayHost.acquireRelayHost);
    expect(entry.getRelayHostRefCount).toBe(relayHost.getRelayHostRefCount);
    expect(entry.DEFAULT_INTERCEPT_URL).toBe(relayHost.DEFAULT_INTERCEPT_URL);
    expect(entry.DEFAULT_DB_NAME).toBe(relayHost.DEFAULT_DB_NAME);
    expect(entry.DEFAULT_LAZY_VALIDATE_INTERVAL).toBe(relayHost.DEFAULT_LAZY_VALIDATE_INTERVAL);
    expect(entry.DEFAULT_PROFILE_FRESHNESS).toBe(relayHost.DEFAULT_PROFILE_FRESHNESS);
    expect(entry.DEFAULT_FOLLOWS_FRESHNESS).toBe(relayHost.DEFAULT_FOLLOWS_FRESHNESS);
  });

  it('boots the page relay without a widget and serves NIP-01 over it', async () => {
    const host = await entry.acquireRelayHost({ dbName: 'entry-spec-cache' });
    try {
      expect(entry.getRelayHostRefCount()).toBe(1);
      // The point of the export: the global is patched by the acquisition
      // alone, so a client that never saw this module can connect by URL.
      expect(globalThis.WebSocket).not.toBe(originalWebSocket);

      expect(await eoseFor(host.interceptUrl)).toBe('entry-sub');
    } finally {
      await host.release();
    }

    expect(entry.getRelayHostRefCount()).toBe(0);
    expect(globalThis.WebSocket).toBe(originalWebSocket);
  });

  it('keeps the relay up across a widget being added and removed', async () => {
    // Why an embedder holds an acquisition of its own: without one, unmounting
    // the last widget (switching tabs, say) tears the relay down and the next
    // mount pays for a fresh IndexedDB open and upstream connections.
    const host = await entry.acquireRelayHost();
    try {
      const element = document.createElement('nostr-timeline');
      document.body.appendChild(element);
      await waitFor(() => entry.getRelayHostRefCount() === 2, 'the widget to join the relay');

      element.remove();
      await waitFor(() => entry.getRelayHostRefCount() === 1, 'the widget to release');
      expect(globalThis.WebSocket).not.toBe(originalWebSocket);
    } finally {
      await host.release();
    }
  });
});

/** Open a REQ over the intercepted URL and resolve with the EOSE's sub id. */
function eoseFor(interceptUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(interceptUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out waiting for EOSE from the in-page relay'));
    }, 5000);

    socket.onopen = () => {
      socket.send(JSON.stringify(['REQ', 'entry-sub', { kinds: [1], limit: 1 }]));
    };
    socket.onmessage = (message: MessageEvent) => {
      const [type, subscriptionId] = JSON.parse(message.data as string) as [string, string];
      if (type !== 'EOSE') {
        return;
      }
      clearTimeout(timer);
      socket.close();
      resolve(subscriptionId);
    };
  });
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}
