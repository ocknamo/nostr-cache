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
    // `debug` because the origin badges these assertions read are diagnostic
    // and off by default; the fetching itself is unaffected by the flag.
    await page.goto(embedUrl({ relays: upstream.url, debug: 'true' }));
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

  it('subscribes with the filters JSON in place of kinds/limit', async () => {
    page = await browser.newPage();
    // `embedUrl` always sets `kinds=1`, which would render the two notes and
    // never the profile. So wait for the profile's content rather than for a
    // card count: `waitForEventCount` returns the instant the count matches, and
    // one card is also a passing moment on the way to the two notes — a
    // `filters` attribute that was ignored entirely would still satisfy it.
    await page.goto(embedUrl({ relays: upstream.url, filters: '[{"kinds":[0],"limit":10}]' }));
    await page.waitForSelector('nostr-timeline .content:has-text("e2e_author")', {
      timeout: TIMEOUT,
    });

    // The notes can no longer arrive once the kind 0 filter is the one in
    // force, so their absence is a stable fact rather than a snapshot.
    const contents = await page.$$eval('nostr-timeline .content', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? '')
    );
    expect(contents.some((content) => content.includes('from upstream'))).toBe(false);
  });

  it('subscribes with every filter in the JSON array', async () => {
    page = await browser.newPage();
    await page.goto(
      embedUrl({
        relays: upstream.url,
        filters: '[{"kinds":[1],"limit":10},{"kinds":[0],"limit":10}]',
      })
    );

    // Both notes and the profile event: the two filters travel as one REQ, so
    // everything matching either lands in the same timeline.
    await waitForEventCount(page, 3);
  });

  it('serves the same events from the local cache after a reload', async () => {
    const url = embedUrl({ relays: upstream.url, debug: 'true' });
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

  it('hides the origin badges unless debug is set', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url }));
    await waitForEventCount(page, 2);

    // The badges are a diagnostic for whoever embeds the widget; a reader of
    // the embedding site should never see them.
    expect(await originBadges(page)).toEqual([]);
  });

  it('renders the origin badges for a bare debug flag in the query string', async () => {
    page = await browser.newPage();
    // `?debug` with no value, the way an HTML boolean attribute reads.
    await page.goto(`${embedUrl({ relays: upstream.url })}&debug`);
    await waitForEventCount(page, 2);

    expect(await originBadges(page)).toEqual(['upstream', 'upstream']);
  });

  it('still honours the deprecated show-origin=true from an older embed URL', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url, 'show-origin': 'true' }));
    await waitForEventCount(page, 2);

    // Embeds written before the badges became opt-in asked for them explicitly;
    // that request still stands, even though the attribute is deprecated.
    expect(await originBadges(page)).toEqual(['upstream', 'upstream']);
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

  it('serves a cached profile without re-asking upstream, via upstreamFreshness', async () => {
    // The whole canned set, anonymous profile-less author included: one author
    // per filter means their missing kind 0 cannot stop the freshness window
    // from covering the author who does have one.
    const url = embedUrl({ relays: upstream.url });
    const beforeFirstLoad = upstream.reqCountForKind(0);
    page = await browser.newPage();

    await page.goto(url);
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });
    // Two visible authors, so two lookups: one each. Poll rather than read the
    // counter the moment a name appears — the other author's REQ may still be
    // on its way, and counting it against the second load would make the delta
    // below wrong for reasons that have nothing to do with freshness. The
    // counter is cumulative over the whole suite, hence the baseline.
    await expect
      .poll(() => upstream.reqCountForKind(0), { timeout: TIMEOUT })
      .toBe(beforeFirstLoad + 2);
    const afterFirstLoad = upstream.reqCountForKind(0);

    await page.reload();
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });
    // Wait for the one REQ that is expected to reach upstream, then let any
    // second one (there should be none) have its chance to show up too.
    await expect
      .poll(() => upstream.reqCountForKind(0), { timeout: TIMEOUT })
      .toBeGreaterThanOrEqual(afterFirstLoad + 1);
    await page.waitForTimeout(500);

    // The widget asks again for both authors on every load. Exactly one of
    // those reaches the upstream: the anonymous author has no kind 0 to cache,
    // so nothing can be fresh for them — while the author who does have one is
    // served from IndexedDB. Under a single filter naming both, the missing
    // one would have dragged the other upstream as well.
    expect(upstream.reqCountForKind(0)).toBe(afterFirstLoad + 1);
  });

  it('honours profile-freshness=0 from the iframe query string', async () => {
    // The default window is a day, so without the parameter reaching the relay
    // the reload below would serve both profiles from IndexedDB and no REQ
    // would leave the page — which is exactly what this asserts against.
    const url = embedUrl({ relays: upstream.url, 'profile-freshness': '0' });
    const beforeFirstLoad = upstream.reqCountForKind(0);
    page = await browser.newPage();

    await page.goto(url);
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });
    await expect
      .poll(() => upstream.reqCountForKind(0), { timeout: TIMEOUT })
      .toBe(beforeFirstLoad + 2);
    const afterFirstLoad = upstream.reqCountForKind(0);

    await page.reload();
    await page.waitForSelector('nostr-timeline .name:text-is("E2E テスト著者")', {
      timeout: TIMEOUT,
    });
    // Both authors are looked up again and, with the window switched off, both
    // lookups are forwarded upstream even though one profile is cached.
    await expect
      .poll(() => upstream.reqCountForKind(0), { timeout: TIMEOUT })
      .toBe(afterFirstLoad + 2);
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

  describe('rich note bodies', () => {
    /** A note carrying a link, an image and a `nostr:` mention. */
    const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';

    async function startRichUpstream(): Promise<MockUpstreamRelay> {
      return startMockUpstreamRelay(
        await Promise.all([
          createTestEvent(getRandomSecret(), {
            created_at: 1_700_000_400,
            content: `link https://example.com/a and ${site.avatarUrl} plus nostr:${NPUB}`,
          }),
        ])
      );
    }

    it('links URLs, embeds images and decorates mentions', async () => {
      const disposable = await startRichUpstream();
      try {
        page = await browser.newPage();
        await page.goto(embedUrl({ relays: disposable.url }));
        await waitForEventCount(page, 1);

        // The plain URL becomes a real link, opened without handing the target
        // a window handle or the embedding page's referrer.
        const links = await page.$$eval('nostr-timeline .content a', (nodes) =>
          nodes.map((node) => ({
            href: node.getAttribute('href'),
            rel: node.getAttribute('rel'),
            target: node.getAttribute('target'),
          }))
        );
        expect(links).toEqual([
          { href: 'https://example.com/a', rel: 'noopener noreferrer nofollow', target: '_blank' },
        ]);

        // The image URL is lifted out of the text and rendered as an
        // attachment, which really loads from the host that served it.
        const image = await page.waitForSelector('nostr-timeline .media img', {
          timeout: TIMEOUT,
        });
        expect(await image.getAttribute('src')).toBe(site.avatarUrl);
        expect(await image.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1);

        // The mention is decoration, not a link: the widget has no client to
        // send a reader to.
        const mention = await page.waitForSelector('nostr-timeline .mention', { timeout: TIMEOUT });
        expect((await mention.textContent())?.trim()).toBe('npub10elf…jptg');
        expect(await page.$$('nostr-timeline .mention a')).toHaveLength(0);

        const text = await page.$eval(
          'nostr-timeline .content',
          (node) => node.textContent?.trim() ?? ''
        );
        expect(text).not.toContain(site.avatarUrl);
      } finally {
        await disposable.close();
      }
    });

    it('honours show-media=false from the iframe query string', async () => {
      const disposable = await startRichUpstream();
      try {
        page = await browser.newPage();
        await page.goto(embedUrl({ relays: disposable.url, 'show-media': 'false' }));
        await waitForEventCount(page, 1);
        await page.waitForSelector('nostr-timeline .content a', { timeout: TIMEOUT });

        // Nothing is fetched from the image host, but the URL is still there as
        // a link — the reader loses the preview, not the information.
        expect(await page.$$('nostr-timeline .media')).toHaveLength(0);
        const hrefs = await page.$$eval('nostr-timeline .content a', (nodes) =>
          nodes.map((node) => node.getAttribute('href'))
        );
        expect(hrefs).toEqual(['https://example.com/a', site.avatarUrl]);
      } finally {
        await disposable.close();
      }
    });
  });

  it('keeps the name, the handle and the time on one line in a narrow embed', async () => {
    // The card header's single-line layout is pure CSS, so the component tests
    // (jsdom, which computes no layout) cannot see it. Its own upstream, for a
    // profile whose name and handle are both far too long to fit.
    const author = getRandomSecret();
    const disposable = await startMockUpstreamRelay(
      await Promise.all([
        createTestEvent(author, { content: 'one line', created_at: 1_700_000_300 }),
        createTestEvent(author, {
          kind: 0,
          created_at: 1_700_000_250,
          tags: [],
          content: JSON.stringify({
            name: 'an_extremely_long_handle_that_cannot_possibly_fit',
            display_name: 'とてもとても長い表示名がここに入りますよ本当に長い',
          }),
        }),
      ])
    );
    try {
      // Narrow enough that neither the name nor the handle fits, which is the
      // case the layout is built for.
      page = await browser.newPage({ viewport: { width: 320, height: 600 } });
      await page.goto(embedUrl({ relays: disposable.url }));
      await waitForEventCount(page, 1);
      await page.waitForSelector('nostr-timeline .handle', { timeout: TIMEOUT });

      const layout = await page.$eval('nostr-timeline header', (header) => {
        const measure = (selector: string) => {
          const node = header.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            return undefined;
          }
          const { top, bottom, width } = node.getBoundingClientRect();
          return { top, bottom, width, clipped: node.scrollWidth > node.clientWidth };
        };
        return {
          name: measure('.name'),
          handle: measure('.handle'),
          time: measure('time'),
          headerOverflows: header.scrollWidth > header.clientWidth,
          pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      const { name, handle, time } = layout;
      // One line: the name's box and the timestamp's box overlap vertically.
      // Comparing their tops would fail on the baseline alignment alone, since
      // the two are set at different sizes.
      expect(name && time && name.top < time.bottom && time.top < name.bottom).toBe(true);
      // Both are too long for the row, so both are cut short — and the handle
      // keeps a box to cut short, rather than being squeezed out of existence.
      expect(name?.clipped).toBe(true);
      expect(handle?.clipped).toBe(true);
      expect(handle?.width ?? 0).toBeGreaterThan(0);
      // A header that grew past the card would hand the embedding page a
      // horizontal scrollbar.
      expect(layout.headerOverflows).toBe(false);
      expect(layout.pageScrolls).toBe(false);
    } finally {
      await disposable.close();
    }
  });

  it('opens the date tooltip on a tap, where there is no hover to open it', async () => {
    // A real touch screen: `hasTouch` is what makes `tap()` dispatch touch
    // events rather than a mouse click, and a touch reader is the one who
    // cannot open a tooltip by hovering.
    page = await browser.newPage({
      viewport: { width: 320, height: 600 },
      hasTouch: true,
      isMobile: true,
    });
    await page.goto(embedUrl({ relays: upstream.url }));
    await waitForEventCount(page, 2);

    const tooltips = () =>
      page?.$$eval('nostr-timeline .date-tip', (nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? '')
      ) ?? Promise.resolve([]);
    /** Where the first card's note sits, to catch the tooltip shoving it. */
    const noteTop = () =>
      page?.$eval('nostr-timeline .content', (note) => note.getBoundingClientRect().top) ??
      Promise.resolve(0);

    expect(await tooltips()).toEqual([]);
    const before = await noteTop();

    const timestamps = await page.$$('nostr-timeline .timestamp');
    await timestamps[0].tap();

    // Only the tapped card opens, and what it shows is the date the header
    // leaves out.
    const opened = await tooltips();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('2023');
    // A tooltip floats over the card: opening one must not move the note under
    // it, nor re-flow the header it hangs from.
    expect(await noteTop()).toBe(before);

    const geometry = () =>
      page?.$eval('nostr-timeline .date-tip', (tip) => {
        const { top, bottom, right, width } = tip.getBoundingClientRect();
        const time = tip.closest('.header-row')?.querySelector('time')?.getBoundingClientRect() ?? {
          top: 0,
          bottom: 0,
          right: 0,
        };
        return {
          top,
          aboveTime: bottom <= time.top,
          belowTime: top >= time.bottom,
          alignedWithTime: right >= time.right,
          width,
        };
      }) ?? Promise.resolve(undefined);

    const first = await geometry();
    expect(first?.alignedWithTime).toBe(true);
    expect(first?.width).toBeGreaterThan(0);
    // The first card has only a small gap above it now, so its tooltip flips
    // under the header rather than clipping off the top of the embed.
    expect(first?.belowTime).toBe(true);
    expect(first?.top).toBeGreaterThanOrEqual(0);
    // Flipped or not, it floats: the note underneath has not moved.
    expect(await noteTop()).toBe(before);

    await timestamps[0].tap();
    expect(await tooltips()).toEqual([]);

    // Every other card keeps the upward tooltip — there is a card above it to
    // open into.
    await timestamps[1].tap();
    const second = await geometry();
    expect(second?.aboveTime).toBe(true);
    expect(second?.top).toBeGreaterThanOrEqual(0);

    await timestamps[1].tap();
    expect(await tooltips()).toEqual([]);
  });

  it('caps a long post and scrolls it inside its own card', async () => {
    // Long enough to fill several screens on its own, which is the thing the
    // cap exists for: one post like this used to push everything else out of
    // the timeline.
    const long = Array.from({ length: 80 }, (_, line) => `${line + 1} 行目のとても長い本文`).join(
      '\n'
    );
    const events = await Promise.all([
      createTestEvent(getRandomSecret(), { content: long, created_at: 1_700_000_300 }),
      createTestEvent(undefined, { content: 'みじかい投稿', created_at: 1_700_000_200 }),
    ]);
    const disposable = await startMockUpstreamRelay(events);
    try {
      page = await browser.newPage({ viewport: { width: 360, height: 900 } });
      await page.goto(
        embedUrl({
          relays: disposable.url,
          actions: JSON.stringify([{ id: 'reply', label: '返信', icon: '💬' }]),
        })
      );
      await waitForEventCount(page, 2);

      const cards = await page.$$eval('nostr-timeline .event-card', (nodes) =>
        nodes.map((card) => {
          const note = card.querySelector('.note') as HTMLElement;
          const header = card.querySelector('header') as HTMLElement;
          const bar = card.querySelector('.actions') as HTMLElement;
          const box = card.getBoundingClientRect();
          return {
            height: Math.round(box.height),
            scrolls: note.scrollHeight - note.clientHeight > 1,
            tabindex: note.getAttribute('tabindex'),
            faded: note.classList.contains('overflowing'),
            headerInside: header.getBoundingClientRect().top >= box.top - 1,
            actionsInside: bar.getBoundingClientRect().bottom <= box.bottom + 1,
          };
        })
      );

      // The whole post, padding included: --nt-card-max-height is a border-box
      // height, so the number an embedder writes is the height they get.
      expect(cards[0].height).toBe(420);
      expect(cards[0].scrolls).toBe(true);
      // The parts that must not scroll away with the body.
      expect(cards[0].headerInside).toBe(true);
      expect(cards[0].actionsInside).toBe(true);
      // WCAG 2.1.1: the scroll area is reachable without a pointer, and the
      // bottom fade says there is more below.
      expect(cards[0].tabindex).toBe('0');
      expect(cards[0].faded).toBe(true);

      // A post that fits is untouched — no cap artefacts, no stray tab stop.
      expect(cards[1].height).toBeLessThan(420);
      expect(cards[1].scrolls).toBe(false);
      expect(cards[1].tabindex).toBeNull();
      expect(cards[1].faded).toBe(false);

      // The long post scrolls inside its own box rather than moving the page.
      const scrolled = await page.$eval('nostr-timeline .note', (note) => {
        note.scrollTop = note.scrollHeight;
        return {
          scrollTop: note.scrollTop,
          pageScrolled: window.scrollY,
        };
      });
      expect(scrolled.scrollTop).toBeGreaterThan(0);
      expect(scrolled.pageScrolled).toBe(0);
    } finally {
      await disposable.close();
    }
  });

  it('keeps a small top gap and fades what the relay has not validated yet', async () => {
    page = await browser.newPage();
    await page.goto(embedUrl({ relays: upstream.url }));
    await waitForEventCount(page, 2);

    const listPadding = await page.$eval(
      'nostr-timeline .timeline ul',
      (list) => getComputedStyle(list).paddingTop
    );
    // A third of the 48px the first card's tooltip used to need above it; the
    // tooltip flips downward there now instead.
    expect(listPadding).toBe('16px');

    // The relay validates lazily, so the cards arrive unverified and faded.
    const faded = await page.$$eval('nostr-timeline .event-card', (cards) =>
      cards.map((card) => getComputedStyle(card).opacity)
    );
    expect(faded).toEqual(['0.6', '0.6']);

    // ...and come back to full strength once it has vouched for them. Waited
    // for rather than sampled: the fade is a 200ms transition, so reading the
    // moment the ✓ appears catches a card partway there (CI saw 0.995).
    await page.waitForSelector('nostr-timeline .verified', { timeout: TIMEOUT });
    await page.waitForFunction(
      () => {
        const root = document.querySelector('nostr-timeline')?.shadowRoot;
        const cards = [...(root?.querySelectorAll('.event-card') ?? [])];
        return cards.length === 2 && cards.every((card) => getComputedStyle(card).opacity === '1');
      },
      undefined,
      { timeout: TIMEOUT }
    );
  });

  it('keeps the first card tooltip above the card below it', async () => {
    // A short first card, so its downward tooltip really does reach into the
    // next one — the case where the fade's stacking context bites. A note with
    // a body is tall enough to contain its own tooltip, which is why the ones
    // above cannot catch this.
    const short = await Promise.all([
      createTestEvent(getRandomSecret(), { content: '', created_at: 1_700_000_300 }),
      createTestEvent(undefined, { content: 'below the tooltip', created_at: 1_700_000_200 }),
    ]);
    const disposable = await startMockUpstreamRelay(short);
    try {
      page = await browser.newPage({ viewport: { width: 240, height: 600 } });
      await page.goto(embedUrl({ relays: disposable.url, 'show-avatars': 'false' }));
      await waitForEventCount(page, 2);

      await (await page.$$('nostr-timeline .timestamp'))[0].click();

      const layered = await page.$eval('nostr-timeline .date-tip', (tip) => {
        const root = tip.getRootNode() as ShadowRoot;
        const next = root.querySelectorAll('.event-card')[1].getBoundingClientRect();
        const box = tip.getBoundingClientRect();
        // Hit testing follows paint order, so it answers what the geometry
        // cannot: every card is its own stacking context while it is faded, and
        // the next one paints last — over this tooltip, unless the card holding
        // it is lifted.
        (tip as HTMLElement).style.pointerEvents = 'auto';
        const at = root.elementFromPoint((box.left + box.right) / 2, box.bottom - 2);
        return { reachesNextCard: box.bottom > next.top, topmost: at === tip || tip.contains(at) };
      });

      // The premise first: without the overlap the assertion below is vacuous.
      expect(layered.reachesNextCard).toBe(true);
      expect(layered.topmost).toBe(true);
    } finally {
      await disposable.close();
    }
  });

  it('renders the embedder actions and reports a press to the embedding page', async () => {
    page = await browser.newPage();
    await page.goto(
      embedUrl({
        relays: upstream.url,
        actions: JSON.stringify([
          { id: 'reply', label: '返信', icon: '💬' },
          { id: 'zap', label: 'Zap', icon: '⚡' },
        ]),
      })
    );
    await waitForEventCount(page, 2);

    // The host page is the top-level document here, so its own `parent` is
    // itself: the message it would post to an embedding page lands back on this
    // window, which is what makes the protocol observable from a single page.
    await page.evaluate(() => {
      (window as unknown as { pressed: unknown[] }).pressed = [];
      window.addEventListener('message', (message) => {
        if ((message.data as { type?: string })?.type === 'nostr-timeline:action') {
          (window as unknown as { pressed: unknown[] }).pressed.push(message.data);
        }
      });
    });

    const buttons = await page.$$('nostr-timeline .action');
    // Two buttons per card, in the order they were declared.
    expect(buttons).toHaveLength(4);
    expect(await buttons[0].getAttribute('aria-label')).toBe('返信');

    // Right-aligned, and inside the card: the row must never be what hands the
    // embedding page a horizontal scrollbar.
    const layout = await page.$eval('nostr-timeline .event-card', (card) => {
      const bar = card.querySelector('.actions') as HTMLElement;
      const last = bar.lastElementChild as HTMLElement;
      return {
        justify: getComputedStyle(bar).justifyContent,
        gapToRight: bar.getBoundingClientRect().right - last.getBoundingClientRect().right,
        overflows: bar.scrollWidth > bar.clientWidth + 1,
        pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(layout.justify).toBe('flex-end');
    expect(layout.gapToRight).toBeLessThan(2);
    expect(layout.overflows).toBe(false);
    expect(layout.pageScrolls).toBe(false);

    await buttons[1].click();

    // `postMessage` delivers on a later task, so wait for it rather than
    // assuming the click round trip outran it.
    await page.waitForFunction(
      () => (window as unknown as { pressed: unknown[] }).pressed.length > 0,
      undefined,
      { timeout: TIMEOUT }
    );
    const pressed = await page.evaluate(
      () => (window as unknown as { pressed: { actionId: string; event: NostrEvent }[] }).pressed
    );
    expect(pressed).toHaveLength(1);
    expect(pressed[0].actionId).toBe('zap');
    // The whole event, not just its id: an embedder acting on a press needs the
    // note it was pressed on, and the iframe boundary allows nothing richer.
    const firstCard = await page.$eval(
      'nostr-timeline .content',
      (note) => note.textContent?.trim() ?? ''
    );
    expect(pressed[0].event.content).toBe(firstCard);
  });

  it('serves the profile out of the local cache on a reload', async () => {
    // Its own upstream, because this test shuts it down partway through and the
    // shared one has to stay usable for the rest of the suite.
    const disposable = await startMockUpstreamRelay(cannedEvents);
    const url = embedUrl({ relays: disposable.url, debug: 'true' });
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
