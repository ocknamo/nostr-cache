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

import type { NostrEvent } from '@nostr-cache/shared';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import { createTestEvent, getRandomSecret } from '../../src/test-events.js';

const TIMEOUT = 15000;

describe('Embeddable timeline E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;
  /** The canned set, kept so a test can stand up its own upstream from it. */
  let cannedEvents: NostrEvent[] = [];

  beforeAll(async () => {
    // The site comes up first because the canned profile's `picture` points at
    // an image it serves, and its port is only known once it is listening.
    site = await startEmbedSiteServer();
    // One author is given a fixed key so a kind 0 event can be signed by the
    // same identity as their note; the other stays anonymous, which is what
    // keeps the pubkey fallback covered.
    const authorSeckey = getRandomSecret();
    cannedEvents = await Promise.all([
      createTestEvent(authorSeckey, { content: 'from upstream one', created_at: 1_700_000_100 }),
      createTestEvent(undefined, { content: 'from upstream two', created_at: 1_700_000_200 }),
      createTestEvent(authorSeckey, {
        kind: 0,
        created_at: 1_700_000_050,
        tags: [],
        content: JSON.stringify({
          name: 'e2e_author',
          display_name: 'E2E テスト著者',
          picture: site.avatarUrl,
        }),
      }),
    ]);
    upstream = await startMockUpstreamRelay(cannedEvents);
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
    // Count kind 1 REQs only: the widget also opens a kind 0 subscription, and
    // counting every REQ would let this pass even if the timeline stopped
    // reading through entirely.
    const afterFirstLoad = upstream.reqCountForKind(1);

    await page.reload();
    await waitForEventCount(page, 2);

    // A cache that stopped consulting the upstream would be fast and stale;
    // read-through means even a warm load forwards the REQ.
    expect(upstream.reqCountForKind(1)).toBeGreaterThan(afterFirstLoad);
  });

  it('hides the origin badges when show-origin is false', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url, 'show-origin': 'false' }));
    await waitForEventCount(page, 2);

    expect(await originBadges(page)).toEqual([]);
  });

  it('fetches kind 0 and renders the author with their name and avatar', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url }));
    await waitForEventCount(page, 2);

    // The profile arrives on its own subscription after the notes, so wait for
    // the name rather than reading straight after the cards appear.
    const name = await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });
    expect(name).toBeTruthy();
    expect(
      await page.$$eval('nostr-timeline .handle', (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? '')
      )
    ).toContain('@e2e_author');

    const avatar = await page.waitForSelector('nostr-timeline img.avatar', { timeout: TIMEOUT });
    expect(await avatar.getAttribute('src')).toBe(site.avatarUrl);

    // The kind 0 event must not reach the timeline itself: it is a different
    // subscription, and a profile rendered as a note would be a bug.
    const contents = await page.$$eval('nostr-timeline .content', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
    expect(contents.some((content) => content.includes('display_name'))).toBe(false);

    // The anonymous author has no profile, so their card keeps the fallback.
    const names = await page.$$eval('nostr-timeline .name', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
    expect(names.some((value) => value.includes('…'))).toBe(true);
  });

  it('honours show-avatars=false from the iframe query string', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url, 'show-avatars': 'false' }));
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });

    // README offers this as the way to stop the widget loading images from
    // whatever host a profile names, so it has to reach the iframe path too —
    // the name still renders, but nothing is fetched from the avatar host.
    expect(await page.$$('nostr-timeline img.avatar')).toHaveLength(0);
  });

  it('serves the profile out of the local cache on a reload', async () => {
    // Its own upstream, because this test shuts it down partway through and the
    // shared one has to stay usable for the rest of the suite.
    const disposable = await startMockUpstreamRelay(cannedEvents);
    const url = embedUrl({ relays: disposable.url });
    page = await browser.newPage();

    await page.goto(url);
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });

    // Take the upstream away, so anything that renders after this can only have
    // come from IndexedDB. kind 0 is replaceable, so the relay stored it on the
    // first visit — that is what makes avatars appear without a round trip.
    await disposable.close();

    await page.reload();
    await waitForEventCount(page, 2);
    const name = await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });

    expect(name).toBeTruthy();
    expect(await originBadges(page)).toEqual(['cache', 'cache']);
  });
});
