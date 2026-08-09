/**
 * The embed bundle's relay API, exercised through the shipped artifact.
 *
 * `packages/timeline-embed/src/embed-entry.spec.ts` covers the module's
 * exports; what it cannot see is the IIFE wrapper Rollup builds around them.
 * The bundle's global carries both the component and the relay API, and which
 * one lands where is decided by build config (`output.exports`), not by the
 * source — so "a page can call `NostrTimelineEmbed.acquireRelayHost`" is only
 * true if the built file says so.
 *
 * The page under test mounts no widget at all. That is the case the API exists
 * for: a site with its own Nostr components points them at `interceptUrl` and
 * gets the cache underneath them, with no timeline on the page.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import { createTestEvent, getRandomSecret } from '../../src/test-events.js';

const TIMEOUT = 15000;

/** Shape of the bundle's global, as the page sees it. */
interface EmbedGlobal {
  acquireRelayHost(config?: Record<string, unknown>): Promise<{
    interceptUrl: string;
    release(): Promise<void>;
  }>;
  getRelayHostRefCount(): number;
  DEFAULT_INTERCEPT_URL: string;
  DEFAULT_DB_NAME: string;
  DEFAULT_PROFILE_FRESHNESS: number;
  DEFAULT_FOLLOWS_FRESHNESS: number;
  default: unknown;
}

/** The page's globals, as this spec reaches for them. */
interface EmbedWindow extends Window {
  NostrTimelineEmbed: EmbedGlobal;
  /** `lib.dom` declares the constructor globally rather than on `Window`. */
  WebSocket: typeof WebSocket;
  /** Captured by the host page before the bundle can patch it. */
  __originalWebSocket: unknown;
  /** The acquisition under test, parked so a later `evaluate` can release it. */
  __host: { release(): Promise<void> };
}

describe('Embed bundle relay API E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;
  let cannedEvent: NostrEvent;

  beforeAll(async () => {
    site = await startEmbedSiteServer();
    cannedEvent = await createTestEvent(getRandomSecret(), {
      content: 'served through the page relay',
      created_at: 1_700_000_300,
    });
    upstream = await startMockUpstreamRelay([cannedEvent]);
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await upstream?.close();
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** Open the bundle-only page; a fresh database keeps the cases independent. */
  async function openScriptOnlyPage(): Promise<Page> {
    const opened = await browser.newPage();
    await opened.goto(site.scriptOnlyUrl, { waitUntil: 'load' });
    dbCounter += 1;
    return opened;
  }

  it('exposes the relay API and still registers both elements', async () => {
    page = await openScriptOnlyPage();

    const published = await page.evaluate(() => {
      const { NostrTimelineEmbed: embed } = window as unknown as EmbedWindow;
      return {
        acquire: typeof embed?.acquireRelayHost,
        refCount: typeof embed?.getRelayHostRefCount,
        interceptUrl: embed?.DEFAULT_INTERCEPT_URL,
        dbName: embed?.DEFAULT_DB_NAME,
        profileFreshness: embed?.DEFAULT_PROFILE_FRESHNESS,
        followsFreshness: embed?.DEFAULT_FOLLOWS_FRESHNESS,
        // Named exports moved the component to `.default`; it must still be
        // there for pages that reached for it before they existed.
        component: typeof embed?.default,
        // The registration side effect is the thing the exports could have
        // cost: a page loading this script gets the elements either way.
        timeline: Boolean(customElements.get('nostr-timeline')),
        followTimeline: Boolean(customElements.get('nostr-follow-timeline')),
      };
    });

    expect(published).toEqual({
      acquire: 'function',
      refCount: 'function',
      interceptUrl: 'ws://nostr-cache.invalid',
      dbName: 'nostr-cache-embed',
      profileFreshness: 86_400,
      followsFreshness: 600,
      component: 'function',
      timeline: true,
      followTimeline: true,
    });
  });

  it('serves a plain WebSocket client through the cache, with no widget on the page', async () => {
    page = await openScriptOnlyPage();

    const first = await page.evaluate(
      async ([relayUrl, dbName]) => {
        const win = window as unknown as EmbedWindow;
        const host = await win.NostrTimelineEmbed.acquireRelayHost({
          upstreamRelays: [relayUrl],
          dbName,
        });
        win.__host = host;
        return {
          refCount: win.NostrTimelineEmbed.getRelayHostRefCount(),
          interceptUrl: host.interceptUrl,
          // The emulator patches the global as it starts; a client that never
          // saw this module connects by URL alone because of it.
          patched: win.WebSocket !== win.__originalWebSocket,
        };
      },
      [upstream.url, `e2e-relay-api-${dbCounter}`] as const
    );

    expect(first).toEqual({
      refCount: 1,
      interceptUrl: 'ws://nostr-cache.invalid',
      patched: true,
    });

    // Read through to upstream over a hand-rolled NIP-01 client — no widget, no
    // library, exactly what an embedder's own components do.
    const contents = await page.evaluate(
      ({ interceptUrl, timeout }) =>
        new Promise<string[]>((resolve, reject) => {
          const received: string[] = [];
          const socket = new WebSocket(interceptUrl);
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error('timed out waiting for EOSE'));
          }, timeout);
          socket.onopen = () => {
            socket.send(JSON.stringify(['REQ', 'api-sub', { kinds: [1], limit: 10 }]));
          };
          socket.onmessage = (message) => {
            const [type, , event] = JSON.parse(message.data) as [
              string,
              string,
              { content: string },
            ];
            if (type === 'EVENT') {
              received.push(event.content);
            } else if (type === 'EOSE') {
              clearTimeout(timer);
              socket.close();
              resolve(received);
            }
          };
        }),
      { interceptUrl: 'ws://nostr-cache.invalid', timeout: TIMEOUT }
    );

    expect(contents).toEqual([cannedEvent.content]);

    // Releasing the only acquisition shuts the relay down and gives the page
    // its own WebSocket back — the contract every caller of the API is on.
    const afterRelease = await page.evaluate(async () => {
      const win = window as unknown as EmbedWindow;
      await win.__host.release();
      return {
        refCount: win.NostrTimelineEmbed.getRelayHostRefCount(),
        restored: win.WebSocket === win.__originalWebSocket,
      };
    });

    expect(afterRelease).toEqual({ refCount: 0, restored: true });
  });

  it('shares its relay with a widget added to the same page', async () => {
    page = await openScriptOnlyPage();
    const dbName = `e2e-relay-api-shared-${dbCounter}`;

    await page.evaluate(
      async ([relayUrl, name]) => {
        const win = window as unknown as EmbedWindow;
        win.__host = await win.NostrTimelineEmbed.acquireRelayHost({
          upstreamRelays: [relayUrl],
          dbName: name,
        });
      },
      [upstream.url, dbName] as const
    );

    // Matching settings, so the widget joins the running relay instead of
    // warning about a conflict — the arrangement the README prescribes.
    await page.evaluate(
      ([relayUrl, name]) => {
        const element = document.createElement('nostr-timeline');
        element.setAttribute('relays', relayUrl);
        element.setAttribute('db-name', name);
        element.setAttribute('kinds', '1');
        element.setAttribute('limit', '10');
        document.body.appendChild(element);
      },
      [upstream.url, dbName] as const
    );

    // Playwright's selector engine pierces the element's shadow root; the host
    // element's own textContent is empty.
    const card = await page.waitForSelector('nostr-timeline .content', { timeout: TIMEOUT });
    expect(await card.textContent()).toContain(cannedEvent.content);

    // The widget leaving does not take the relay with it: the embedder still
    // holds an acquisition, which is the point of calling the API directly.
    const afterRemoval = await page.evaluate(async () => {
      const win = window as unknown as EmbedWindow;
      document.querySelector('nostr-timeline')?.remove();
      // Disconnection teardown is asynchronous; give it a turn to land.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        refCount: win.NostrTimelineEmbed.getRelayHostRefCount(),
        stillPatched: win.WebSocket !== win.__originalWebSocket,
      };
    });

    expect(afterRemoval).toEqual({ refCount: 1, stillPatched: true });

    await page.evaluate(() => (window as unknown as EmbedWindow).__host.release());
  });
});
