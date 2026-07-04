/**
 * Browser client-server E2E test.
 *
 * Bundles the cache-relay for the browser, serves it over a real http origin,
 * and runs it inside Chromium via Playwright. A page-side NIP-01 client talks
 * to the in-browser relay through the WebSocketServerEmulator, exercising the
 * full flow against real IndexedDB (Dexie). Signed events are precomputed in
 * Node and injected, so no in-page signing is required.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { buildBrowserBundle } from '../../src/build-bundle.js';
import { type StaticServer, startStaticServer } from '../../src/static-server.js';
import { createTestEvent } from '../../src/test-events.js';

// Narrow view of the API exposed on window by the bundled browser entry.
interface NostrE2EApi {
  startRelay: (url: string, dbName?: string) => Promise<void>;
  newClient: (url: string) => number;
  waitOpen: (id: number) => Promise<void>;
  send: (id: number, message: unknown[]) => void;
  waitForMessage: (
    id: number,
    type: string,
    subscriptionId?: string,
    timeoutMs?: number
  ) => Promise<unknown[]>;
  closeClient: (id: number) => void;
}
declare global {
  interface Window {
    NostrE2E: NostrE2EApi;
  }
}

describe('Browser client-server E2E', () => {
  let browser: Browser;
  let server: StaticServer;
  let page: Page;
  let dbCounter = 0;

  beforeAll(async () => {
    const bundlePath = await buildBrowserBundle();
    server = await startStaticServer(bundlePath);
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(server.baseUrl);
  });

  afterEach(async () => {
    await page?.close();
  });

  /** Boot a relay with a fresh database and open one client, returning its id. */
  async function bootRelayAndClient(dbName: string): Promise<number> {
    await page.evaluate(({ url, db }) => window.NostrE2E.startRelay(url, db), {
      url: server.wsUrl,
      db: dbName,
    });
    const clientId = await page.evaluate((url) => window.NostrE2E.newClient(url), server.wsUrl);
    await page.evaluate((id) => window.NostrE2E.waitOpen(id), clientId);
    return clientId;
  }

  it('boots an in-browser relay and connects a client', async () => {
    const clientId = await bootRelayAndClient(`e2e-connect-${dbCounter++}`);
    expect(clientId).toBeGreaterThan(0);
  });

  it('accepts a signed EVENT and rejects a tampered one', async () => {
    const clientId = await bootRelayAndClient(`e2e-validate-${dbCounter++}`);
    const event = await createTestEvent();
    // Give the tampered event a distinct id (so its OK response does not collide
    // with the accepted event's) while leaving the signature invalid.
    const tamperedId = (event.id[0] === '0' ? '1' : '0') + event.id.slice(1);
    const tampered: NostrEvent = { ...event, id: tamperedId, content: 'tampered' };

    const okGood = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['EVENT', ev]);
        return window.NostrE2E.waitForMessage(id, 'OK', ev.id);
      },
      { id: clientId, ev: event }
    );
    expect(okGood[2]).toBe(true);

    const okBad = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['EVENT', ev]);
        return window.NostrE2E.waitForMessage(id, 'OK', ev.id);
      },
      { id: clientId, ev: tampered }
    );
    expect(okBad[2]).toBe(false);
  });

  it('returns stored events then EOSE for a REQ', async () => {
    const clientId = await bootRelayAndClient(`e2e-req-${dbCounter++}`);
    const event = await createTestEvent();

    const result = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['EVENT', ev]);
        await window.NostrE2E.waitForMessage(id, 'OK', ev.id);

        window.NostrE2E.send(id, ['REQ', 'stored', { kinds: [1], authors: [ev.pubkey] }]);
        const stored = await window.NostrE2E.waitForMessage(id, 'EVENT', 'stored');
        const eose = await window.NostrE2E.waitForMessage(id, 'EOSE', 'stored');
        return { stored, eose };
      },
      { id: clientId, ev: event }
    );

    expect((result.stored[2] as NostrEvent).id).toBe(event.id);
    expect(result.eose[0]).toBe('EOSE');
  });

  it('persists events in real IndexedDB (Dexie)', async () => {
    const dbName = `e2e-idb-${dbCounter++}`;
    const clientId = await bootRelayAndClient(dbName);
    const event = await createTestEvent();

    await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['EVENT', ev]);
        await window.NostrE2E.waitForMessage(id, 'OK', ev.id);
      },
      { id: clientId, ev: event }
    );

    // The Dexie database should now exist in the browser.
    const dbNames = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.map((d) => d.name);
    });
    expect(dbNames).toContain(dbName);

    // A brand-new subscription must return the persisted event.
    const stored = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['REQ', 'reread', { ids: [ev.id] }]);
        return window.NostrE2E.waitForMessage(id, 'EVENT', 'reread');
      },
      { id: clientId, ev: event }
    );
    expect((stored[2] as NostrEvent).id).toBe(event.id);
  });

  it('broadcasts a live event to an active subscription', async () => {
    const clientId = await bootRelayAndClient(`e2e-live-${dbCounter++}`);
    const event = await createTestEvent(undefined, { content: 'browser live' });

    const live = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['REQ', 'live', { kinds: [1], authors: [ev.pubkey] }]);
        await window.NostrE2E.waitForMessage(id, 'EOSE', 'live');

        window.NostrE2E.send(id, ['EVENT', ev]);
        await window.NostrE2E.waitForMessage(id, 'OK', ev.id);
        return window.NostrE2E.waitForMessage(id, 'EVENT', 'live');
      },
      { id: clientId, ev: event }
    );

    expect((live[2] as NostrEvent).content).toBe('browser live');
  });

  it('closes a subscription with CLOSED', async () => {
    const clientId = await bootRelayAndClient(`e2e-close-${dbCounter++}`);

    const closed = await page.evaluate(async (id) => {
      window.NostrE2E.send(id, ['REQ', 'to-close', { kinds: [1] }]);
      await window.NostrE2E.waitForMessage(id, 'EOSE', 'to-close');
      window.NostrE2E.send(id, ['CLOSE', 'to-close']);
      return window.NostrE2E.waitForMessage(id, 'CLOSED', 'to-close');
    }, clientId);

    expect(closed[0]).toBe('CLOSED');
  });

  it('persists events across a page reload', async () => {
    const dbName = `e2e-reload-${dbCounter++}`;
    const clientId = await bootRelayAndClient(dbName);
    const event = await createTestEvent();

    await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['EVENT', ev]);
        await window.NostrE2E.waitForMessage(id, 'OK', ev.id);
      },
      { id: clientId, ev: event }
    );

    // Reload the page, re-boot the relay against the same database.
    await page.reload();
    const reloadedClient = await bootRelayAndClient(dbName);

    const stored = await page.evaluate(
      async ({ id, ev }) => {
        window.NostrE2E.send(id, ['REQ', 'after-reload', { ids: [ev.id] }]);
        return window.NostrE2E.waitForMessage(id, 'EVENT', 'after-reload');
      },
      { id: reloadedClient, ev: event }
    );

    expect((stored[2] as NostrEvent).id).toBe(event.id);
  });
});
