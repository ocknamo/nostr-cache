/**
 * Follow-timeline E2E.
 *
 * `<nostr-follow-timeline>` is the first widget whose subscription filter is
 * not known at startup: it fetches the subject's NIP-02 follow list from a relay
 * and only then builds the timeline REQ. That two-stage shape is what this
 * suite exercises in real Chromium, against real IndexedDB and a stand-in
 * upstream relay.
 *
 * Two claims matter most:
 *
 * 1. Both stages really happen, and the timeline shows exactly the followed
 *    authors' notes — not everyone's.
 * 2. A second load does not ask upstream for the follow list again. That is the
 *    kind 3 freshness window, and it is the reason a cache sits in front of the
 *    upstream at all: without it every visit pays a round trip *before* the
 *    timeline REQ can even be issued.
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

describe('Follow timeline E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;
  /** The subject whose follow list drives the timeline. */
  let subject: string;
  /** Someone the subject follows. */
  let friend: string;
  let cannedEvents: NostrEvent[] = [];

  beforeAll(async () => {
    const subjectKey = getRandomSecret();
    const friendKey = getRandomSecret();
    const strangerKey = getRandomSecret();

    const subjectNote = await createTestEvent(subjectKey, {
      content: 'a post by the subject',
      created_at: 1_700_000_100,
    });
    const friendNote = await createTestEvent(friendKey, {
      content: 'a post by a follow',
      created_at: 1_700_000_200,
    });
    // Nobody follows this one, and no spec ever names their pubkey: their note
    // reaching the timeline could only mean the filter had no `authors`.
    const strangerNote = await createTestEvent(strangerKey, {
      content: 'a post by a stranger',
      created_at: 1_700_000_300,
    });
    subject = subjectNote.pubkey;
    friend = friendNote.pubkey;

    const followList = await createTestEvent(subjectKey, {
      kind: 3,
      created_at: 1_700_000_050,
      tags: [['p', friend]],
      content: '',
    });

    cannedEvents = [subjectNote, friendNote, strangerNote, followList];
    upstream = await startMockUpstreamRelay(cannedEvents);
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
  function followUrl(params: Record<string, string> = {}): string {
    dbCounter += 1;
    const search = new URLSearchParams({
      'db-name': `e2e-follow-${dbCounter}`,
      pubkey: subject,
      limit: '10',
      ...params,
    });
    return `${site.followEmbedUrl}?${search}`;
  }

  /** The note bodies the widget currently renders, in display order. */
  function contents(target: Page): Promise<string[]> {
    return target.$$eval('nostr-follow-timeline .content', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
  }

  async function waitForEventCount(target: Page, count: number): Promise<void> {
    const deadline = Date.now() + TIMEOUT;
    let actual = -1;
    while (Date.now() < deadline) {
      actual = (await target.$$('nostr-follow-timeline article')).length;
      if (actual === count) {
        return;
      }
      await target.waitForTimeout(50);
    }
    throw new Error(`Timed out waiting for ${count} event cards (last saw ${actual})`);
  }

  it('resolves the follow list and shows only those authors', async () => {
    page = await browser.newPage();
    await page.goto(followUrl({ relays: upstream.url }));

    // Two cards: the follow's note, plus the subject's own (include-self is on
    // by default, the way a real client's home timeline reads).
    await waitForEventCount(page, 2);
    const rendered = await contents(page);
    expect(rendered).toContain('a post by a follow');
    expect(rendered).toContain('a post by the subject');
    // The stranger's note is in the same upstream and matches `{"kinds":[1]}`.
    // Its absence is the whole point: the timeline asked for authors, not for
    // the global feed.
    expect(rendered).not.toContain('a post by a stranger');
  });

  it('leaves the subject out when include-self is false', async () => {
    page = await browser.newPage();
    await page.goto(followUrl({ relays: upstream.url, 'include-self': 'false' }));

    await waitForEventCount(page, 1);
    expect(await contents(page)).toEqual(['a post by a follow']);
  });

  it('asks upstream for the follow list once, then serves it from the cache', async () => {
    // The claim the widget is built on. Without the kind 3 freshness window,
    // every load spends a round trip before the timeline REQ can be built.
    const url = followUrl({ relays: upstream.url });
    const before = upstream.reqCountForKind(3);
    page = await browser.newPage();

    await page.goto(url);
    await waitForEventCount(page, 2);
    await expect.poll(() => upstream.reqCountForKind(3), { timeout: TIMEOUT }).toBe(before + 1);

    // Same origin and same db-name, so the reload sees the cache the first
    // visit filled.
    await page.reload();
    await waitForEventCount(page, 2);
    // Give a second REQ (there should be none) its chance to show up.
    await page.waitForTimeout(500);

    expect(upstream.reqCountForKind(3)).toBe(before + 1);
  });

  it('re-asks upstream for the follow list when the window is switched off', async () => {
    const url = followUrl({ relays: upstream.url, 'follows-freshness': '0' });
    const before = upstream.reqCountForKind(3);
    page = await browser.newPage();

    await page.goto(url);
    await waitForEventCount(page, 2);
    await expect.poll(() => upstream.reqCountForKind(3), { timeout: TIMEOUT }).toBe(before + 1);

    await page.reload();
    await waitForEventCount(page, 2);

    // Without the parameter reaching the relay, the cached list would answer
    // this load and no REQ would leave the page.
    await expect.poll(() => upstream.reqCountForKind(3), { timeout: TIMEOUT }).toBe(before + 2);
  });

  it('subscribes to nothing when the subject has no follow list', async () => {
    // Its own upstream with no kind 3 in it, so the fetch comes back empty the
    // way an unpublished follow list does.
    const disposable = await startMockUpstreamRelay(
      cannedEvents.filter((event) => event.kind !== 3)
    );
    try {
      page = await browser.newPage();
      await page.goto(followUrl({ relays: disposable.url }));

      // Named text rather than the bare class: the widget shows a `.follows`
      // notice while it is still resolving, which would match either way.
      const notice = await page.waitForSelector(
        'nostr-follow-timeline .follows:text-is("フォローリストが見つかりませんでした")',
        { timeout: TIMEOUT }
      );
      expect(notice).toBeTruthy();

      // The failure mode this guards against: falling back to an unfiltered
      // kind 1 filter would render the stranger's note — and would have asked
      // the upstream relays for the global feed to do it.
      await page.waitForTimeout(500);
      expect(await contents(page)).toEqual([]);
      expect(disposable.reqCountForKind(1)).toBe(0);
    } finally {
      await disposable.close();
    }
  });

  it('reports an unusable pubkey instead of subscribing to something else', async () => {
    page = await browser.newPage();
    await page.goto(followUrl({ relays: upstream.url, pubkey: 'not-a-pubkey' }));

    const error = await page.waitForSelector('nostr-follow-timeline .error', { timeout: TIMEOUT });
    expect((await error.textContent())?.trim()).toContain('pubkey が不正です');
    expect(await contents(page)).toEqual([]);
  });

  it('serves the whole timeline from the local cache after a reload', async () => {
    const url = followUrl({ relays: upstream.url, debug: 'true' });
    page = await browser.newPage();

    await page.goto(url);
    await waitForEventCount(page, 2);
    expect(
      await page.$$eval('nostr-follow-timeline .origin', (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? '')
      )
    ).toEqual(['upstream', 'upstream']);

    await page.reload();
    await waitForEventCount(page, 2);

    // Both the follow list and the notes come out of IndexedDB, which is the
    // combination the cache exists for.
    expect(
      await page.$$eval('nostr-follow-timeline .origin', (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? '')
      )
    ).toEqual(['cache', 'cache']);
  });

  it('caps the authors it asks for and says so under debug', async () => {
    page = await browser.newPage();
    await page.goto(
      followUrl({
        relays: upstream.url,
        'max-follows': '1',
        'include-self': 'false',
        debug: 'true',
      })
    );

    await waitForEventCount(page, 1);
    // One follow, cap of one: nothing is dropped, so no notice is due.
    expect(await page.$$('nostr-follow-timeline .follows')).toHaveLength(0);
    expect(await contents(page)).toEqual(['a post by a follow']);
  });

  it('reports its height to the embedding page from the shared host script', async () => {
    // The two iframe pages were split; the height protocol deliberately was
    // not. This asserts the follow page really loads the shared copy.
    page = await browser.newPage();
    // The listener is installed by an inline script in the same document as the
    // iframe: `setContent` replaces the document, so a listener registered with
    // `page.evaluate` beforehand would be torn down with the old one.
    await page.setContent(`
      <script>
        window.__heights = [];
        window.addEventListener('message', function (event) {
          if (event.data && event.data.type === 'nostr-timeline:height') {
            window.__heights.push(event.data.height);
          }
        });
      </script>
      <iframe src="${followUrl({ relays: upstream.url })}" style="width:100%;height:200px;border:0"></iframe>
    `);

    await expect
      .poll(
        () => page?.evaluate(() => (window as unknown as { __heights: number[] }).__heights.length),
        { timeout: TIMEOUT }
      )
      .toBeGreaterThan(0);
    const heights = await page.evaluate(
      () => (window as unknown as { __heights: number[] }).__heights
    );
    expect(heights.every((height) => height > 0)).toBe(true);
  });
});
