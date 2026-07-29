/**
 * Embeddable timeline E2E.
 *
 * Loads the built embed bundle in real Chromium against real IndexedDB and a
 * stand-in upstream relay, and checks the claim the widget is built on: the
 * first visit fetches from upstream, and a reload serves the same events out of
 * the local cache.
 *
 * This is the only test that exercises the shipped artifact end to end — the
 * IIFE bundle, the iframe host page, the custom element, the emulator and the
 * read-through path all at once.
 *
 * Assertions use Playwright's waiting primitives plus vitest's `expect` on
 * plain values; the `expect(locator)` matchers belong to @playwright/test,
 * which this suite does not use.
 */

import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import { createTestEvent } from '../../src/test-events.js';

const TIMEOUT = 15000;

describe('Embeddable timeline E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;

  beforeAll(async () => {
    const events = await Promise.all([
      createTestEvent(undefined, { content: 'from upstream one', created_at: 1_700_000_100 }),
      createTestEvent(undefined, { content: 'from upstream two', created_at: 1_700_000_200 }),
    ]);
    upstream = await startMockUpstreamRelay(events);
    site = await startEmbedSiteServer();
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

  /** A fresh database per test keeps the cold and warm cases independent. */
  function embedUrl(params: Record<string, string> = {}): string {
    dbCounter += 1;
    const search = new URLSearchParams({
      'db-name': `e2e-embed-${dbCounter}`,
      kinds: '1',
      limit: '10',
      ...params,
    });
    return `${site.embedUrl}?${search}`;
  }

  /**
   * Wait until the widget has rendered exactly `count` event cards.
   *
   * Polls through Playwright's selector engine rather than `waitForFunction`:
   * the cards live in the custom element's shadow root, which Playwright
   * selectors pierce but `document.querySelectorAll` does not.
   */
  async function waitForEventCount(target: Page, count: number): Promise<void> {
    const deadline = Date.now() + TIMEOUT;
    let actual = -1;
    while (Date.now() < deadline) {
      actual = (await target.$$('nostr-timeline article')).length;
      if (actual === count) {
        return;
      }
      await target.waitForTimeout(50);
    }
    throw new Error(`Timed out waiting for ${count} event cards (last saw ${actual})`);
  }

  /** The cache/upstream badge text of each rendered card, in display order. */
  function originBadges(target: Page): Promise<string[]> {
    return target.$$eval('nostr-timeline .origin', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
  }

  it('renders the widget from the iframe host page', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl());

    // Playwright pierces the shadow root, so this asserts the custom element
    // really rendered rather than merely being defined.
    const timeline = await page.waitForSelector('nostr-timeline .timeline', { timeout: TIMEOUT });
    expect(timeline).toBeTruthy();
  });

  it('reports an empty timeline when no upstream is configured', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl());

    const empty = await page.waitForSelector('nostr-timeline .empty', { timeout: TIMEOUT });
    expect((await empty.textContent())?.trim()).toBe('イベントがありません');
  });

  it('fetches events from the upstream relay and labels them as such', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url }));
    await waitForEventCount(page, 2);

    // Read the cards themselves: the host element's own textContent is empty
    // because the rendered content lives in its shadow root.
    const contents = await page.$$eval('nostr-timeline .content', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
    expect(contents).toContain('from upstream one');
    expect(contents).toContain('from upstream two');
    expect(await originBadges(page)).toEqual(['upstream', 'upstream']);
  });

  it('serves the same events from the local cache after a reload', async () => {
    const url = embedUrl({ relays: upstream.url });
    page = await browser.newPage();

    await page.goto(url);
    await waitForEventCount(page, 2);
    expect(await originBadges(page)).toEqual(['upstream', 'upstream']);

    // Same origin and same db-name, so the reload sees the cache the first
    // visit filled.
    await page.reload();
    await waitForEventCount(page, 2);

    // The events come out of IndexedDB before the upstream answers, and the
    // coordinator's dedup stops the upstream echo from re-delivering them.
    expect(await originBadges(page)).toEqual(['cache', 'cache']);
  });

  it('keeps reading through to the upstream on a warm load', async () => {
    const url = embedUrl({ relays: upstream.url });
    page = await browser.newPage();

    await page.goto(url);
    await waitForEventCount(page, 2);
    const afterFirstLoad = upstream.reqCount();

    await page.reload();
    await waitForEventCount(page, 2);

    // A cache that stopped consulting the upstream would be fast and stale;
    // read-through means even a warm load forwards the REQ.
    expect(upstream.reqCount()).toBeGreaterThan(afterFirstLoad);
  });

  it('hides the origin badges when show-origin is false', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url, 'show-origin': 'false' }));
    await waitForEventCount(page, 2);

    expect(await originBadges(page)).toEqual([]);
  });
});
