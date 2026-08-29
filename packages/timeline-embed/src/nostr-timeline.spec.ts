// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the widget boots on mount.
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventActionDetail } from './lib/event-actions.ts';
import { resetOgpCache } from './lib/ogp.ts';
import {
  DEFAULT_PROFILE_FRESHNESS,
  DEFAULT_STORAGE_MAX_SIZE,
  acquireRelayHost,
  getRelayHostRefCount,
} from './lib/relay-host.ts';
import { makeEvent, seedValidated } from './test-fixtures.ts';

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
    // Here rather than at the end of the test that stubs it: a failed wait
    // throws, and a leaked `fetch` would follow it into the next test.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetOgpCache();
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

  /** Nothing on screen changes if the ceiling stops reaching the relay. */
  describe('max-events attribute', () => {
    async function ceilingOnHost(storageMaxSize: number): Promise<number | undefined> {
      const host = await acquireRelayHost({ storageMaxSize });
      try {
        return (host.relay as unknown as { options: { storageMaxSize?: number } }).options
          .storageMaxSize;
      } finally {
        await host.release();
      }
    }

    it('passes the configured ceiling to the relay', async () => {
      const element = document.createElement('nostr-timeline');
      element.setAttribute('max-events', '250');
      document.body.appendChild(element);
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await ceilingOnHost(250)).toBe(250);
    });

    it('bounds the cache by default when the attribute is absent', async () => {
      const element = document.createElement('nostr-timeline');
      document.body.appendChild(element);
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await ceilingOnHost(DEFAULT_STORAGE_MAX_SIZE)).toBe(DEFAULT_STORAGE_MAX_SIZE);
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

  it('subscribes with the filters attribute when one is given', async () => {
    const element = document.createElement('nostr-timeline');
    element.setAttribute('filters', '[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]');
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('.timeline')),
      'the timeline to render'
    );
    // Both filters travel on one REQ, so the local relay answers the whole
    // subscription with a single EOSE.
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('イベントがありません') === true,
      'EOSE from the local relay'
    );

    const host = await acquireRelayHost();
    try {
      const relay = host.relay as unknown as {
        subscriptionManager: { getAllSubscriptions(): { id: string; filters: unknown[] }[] };
      };
      const timeline = relay.subscriptionManager
        .getAllSubscriptions()
        .find((subscription) => subscription.id.startsWith('timeline-'));
      expect(timeline?.filters).toEqual([
        { kinds: [1], limit: 10 },
        { kinds: [6], limit: 5 },
      ]);
    } finally {
      await host.release();
    }
  });

  it('raises nostr-timeline:action for an author press, with the pubkey', async () => {
    // Each element declares and forwards its own attributes, so this path is
    // per-element plumbing rather than something the card's own tests cover.
    const dbName = `timeline-${crypto.randomUUID()}`;
    const author = 'ee0000000000000000000000000000000000000000000000000000000000000e';
    const seeding = await acquireRelayHost({ dbName });
    try {
      await seedValidated(seeding.storage, [
        makeEvent({
          id: 'ff00000000000000000000000000000000000000000000000000000000000001',
          pubkey: author,
          content: 'カードが 1 枚あればよい',
        }),
      ]);
    } finally {
      await seeding.release();
    }

    const element = document.createElement('nostr-timeline');
    element.setAttribute('db-name', dbName);
    element.setAttribute('author-action', 'open-profile');
    document.body.appendChild(element);

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (press) => {
      presses.push((press as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part="author"]')),
      'the author press target'
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="author"]')?.click();

    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('open-profile');
    expect(presses[0].pubkey).toBe(author);
  });

  it('picks up a shared attribute set after mount', async () => {
    // The attributes the three elements have in common reach the view as one
    // object built in `embed-props.ts`; a read that stopped tracking them would
    // show up nowhere else.
    const dbName = `timeline-${crypto.randomUUID()}`;
    const seeding = await acquireRelayHost({ dbName });
    try {
      await seedValidated(seeding.storage, [
        makeEvent({
          id: 'ff00000000000000000000000000000000000000000000000000000000000003',
          content: 'ボタンが後から付く投稿',
        }),
      ]);
    } finally {
      await seeding.release();
    }

    const element = document.createElement('nostr-timeline');
    element.setAttribute('db-name', dbName);
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('.event-card')),
      'the seeded card'
    );
    expect(element.shadowRoot?.querySelector('[part="actions"]')).toBeNull();

    element.setAttribute('actions', '[{"id":"like","label":"よい"}]');

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part~="action"]')),
      'the button the new attribute asks for'
    );
  });

  it('reports a typo in a shared attribute once, having parsed it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const element = document.createElement('nostr-timeline');
    element.setAttribute('material-icons', 'outline');
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('.timeline')),
      'the timeline to render'
    );

    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('material-icons'))
    ).toHaveLength(1);
  });

  it('rebuilds the relay when a shared attribute set after mount names another one', async () => {
    // The other half of the shared wiring: `relayConfigFrom` is read inside the
    // effect that owns the controller, not in the markup.
    const first = `timeline-${crypto.randomUUID()}`;
    const second = `timeline-${crypto.randomUUID()}`;
    for (const [dbName, content] of [
      [first, 'はじめの DB の投稿'],
      [second, 'あとの DB の投稿'],
    ]) {
      const seeding = await acquireRelayHost({ dbName });
      try {
        await seedValidated(seeding.storage, [makeEvent({ content })]);
      } finally {
        await seeding.release();
      }
    }

    const element = document.createElement('nostr-timeline');
    element.setAttribute('db-name', first);
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.textContent?.includes('はじめの DB の投稿')),
      'the first database'
    );

    element.setAttribute('db-name', second);

    await waitFor(
      () => Boolean(element.shadowRoot?.textContent?.includes('あとの DB の投稿')),
      'the second database'
    );
  });

  it('forwards ogp-proxy, so a card can preview a link', async () => {
    const dbName = `timeline-${crypto.randomUUID()}`;
    const seeding = await acquireRelayHost({ dbName });
    try {
      await seedValidated(seeding.storage, [
        makeEvent({
          id: 'ff00000000000000000000000000000000000000000000000000000000000002',
          content: 'これを見て https://example.com/a',
        }),
      ]);
    } finally {
      await seeding.release();
    }

    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () =>
        new TextEncoder().encode(
          `<!doctype html><html><head><meta property="og:title" content="リンク先の見出し" /></head></html>`
        ).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const element = document.createElement('nostr-timeline');
    element.setAttribute('db-name', dbName);
    element.setAttribute('ogp-proxy', 'https://corsproxy.io/?key=abc');
    document.body.appendChild(element);

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('[part="ogp-title"]')),
      'the link preview card'
    );

    expect(element.shadowRoot?.querySelector('[part="ogp-title"]')?.textContent).toBe(
      'リンク先の見出し'
    );
    // The proxy is asked for the link, with its own query string kept.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://corsproxy.io/?key=abc&url=https%3A%2F%2Fexample.com%2Fa',
      expect.anything()
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
