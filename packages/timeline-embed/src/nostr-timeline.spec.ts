// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the widget boots on mount.
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_FRESHNESS,
  acquireRelayHost,
  getRelayHostRefCount,
} from './lib/relay-host.ts';

/**
 * Verifies the packaging contract of the embed bundle: importing the entry
 * point must define `<nostr-timeline>`, and an element added to the page must
 * boot the shared relay and give it back when removed.
 */
describe('<nostr-timeline> custom element', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeAll(async () => {
    // Importing for the side effect is exactly how the embed bundle registers.
    await import('./embed-entry.ts');
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
    globalThis.WebSocket = originalWebSocket;
  });

  it('registers the element', () => {
    expect(customElements.get('nostr-timeline')).toBeDefined();
  });

  it('renders its timeline into a shadow root', async () => {
    const element = document.createElement('nostr-timeline');
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('.timeline')),
      'the timeline to render'
    );
    expect(element.shadowRoot?.textContent).toContain('読み込み中…');
  });

  it('acquires the shared relay while mounted and releases it on removal', async () => {
    const element = document.createElement('nostr-timeline');
    document.body.appendChild(element);
    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

    element.remove();
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
  });

  it('shares one relay between two widgets on the same page', async () => {
    const first = document.createElement('nostr-timeline');
    const second = document.createElement('nostr-timeline');
    document.body.append(first, second);

    await waitFor(() => getRelayHostRefCount() === 2, 'both widgets to acquire the relay');

    // Removing one must not tear the relay out from under the other.
    first.remove();
    await waitFor(() => getRelayHostRefCount() === 1, 'the first widget to release');
    expect(second.shadowRoot?.querySelector('.timeline')).toBeTruthy();
  });

  /**
   * The `profile-freshness` attribute only matters if it reaches the relay, and
   * nothing on screen would show it if the wiring were dropped — so join the
   * running host (with a matching config, so no conflict is warned about) and
   * read the window it was built with.
   */
  describe('profile-freshness attribute', () => {
    async function windowForKind0(profileFreshness: number): Promise<number | undefined> {
      const host = await acquireRelayHost({ profileFreshness });
      try {
        const gate = (host.relay as unknown as { freshnessGate?: { windows: Map<number, number> } })
          .freshnessGate;
        return gate?.windows.get(0);
      } finally {
        await host.release();
      }
    }

    it('passes the configured window to the relay', async () => {
      const element = document.createElement('nostr-timeline');
      element.setAttribute('profile-freshness', '60');
      document.body.appendChild(element);
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await windowForKind0(60)).toBe(60);
    });

    it('falls back to the default day-long window when the attribute is absent', async () => {
      const element = document.createElement('nostr-timeline');
      document.body.appendChild(element);
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await windowForKind0(DEFAULT_PROFILE_FRESHNESS)).toBe(DEFAULT_PROFILE_FRESHNESS);
    });
  });

  it('reflects attributes into the rendered timeline', async () => {
    const element = document.createElement('nostr-timeline');
    element.setAttribute('kinds', '1');
    element.setAttribute('limit', '5');
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('.timeline')),
      'the timeline to render'
    );
    // No upstream relays are configured, so the local relay answers with an
    // empty EOSE rather than hanging.
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('イベントがありません') === true,
      'EOSE from the local relay'
    );
  });
});

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
