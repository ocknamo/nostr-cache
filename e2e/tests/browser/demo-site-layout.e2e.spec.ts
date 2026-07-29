/**
 * Demo site mobile layout E2E.
 *
 * Guards the one property that the CSS fixes for phone layout all come down to:
 * the page never gets wider than the screen. That is worth an E2E rather than a
 * unit test because jsdom does no layout at all — the whole class of bug (a
 * grid track that cannot shrink below its content, a `minmax()` floor wider
 * than the viewport, an unwrappable header) is invisible without a real engine.
 *
 * Loads the built site, so a regression in the published CSS fails here even if
 * the source looks right.
 */

import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type DemoSiteServer, startDemoSiteServer } from '../../src/demo-site-server.js';

const TIMEOUT = 15000;

/** Narrowest phone still worth supporting, a common phone, and a large phone. */
const MOBILE_WIDTHS = [320, 375, 414];

describe('Demo site mobile layout E2E', () => {
  let browser: Browser;
  let site: DemoSiteServer;
  let page: Page | undefined;

  beforeAll(async () => {
    site = await startDemoSiteServer();
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /**
   * Open the demo at the given width and wait until every panel has rendered.
   *
   * The embed panel mounts only once the in-page relay is running, and it is
   * the widest content on the page — measuring before it appears would miss
   * exactly the overflow this test exists for. The relay is emulated in-page,
   * so this does not depend on reaching any upstream relay.
   */
  async function openAt(width: number): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const opened = await context.newPage();
    await opened.goto(site.baseUrl, { waitUntil: 'load' });
    await opened.waitForSelector('nostr-timeline', { timeout: TIMEOUT });
    return opened;
  }

  for (const width of MOBILE_WIDTHS) {
    it(`fits the viewport at ${width}px without horizontal scrolling`, async () => {
      page = await openAt(width);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(scrollWidth).toBe(clientWidth);
    });
  }

  it('keeps every element inside the viewport at 320px', async () => {
    page = await openAt(320);

    // `<pre>` scrolls its own snippet, so its overflowing `<code>` is by
    // design; everything else is measured, shadow roots included, because the
    // event cards render inside one.
    const offenders = await page.evaluate((viewportWidth) => {
      const found: string[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const element of root.querySelectorAll('*')) {
          if (element.closest('pre')) {
            continue;
          }
          const box = element.getBoundingClientRect();
          if (box.width > 0 && (box.right > viewportWidth + 1 || box.left < -1)) {
            const name =
              typeof element.className === 'string' && element.className
                ? `${element.tagName.toLowerCase()}.${element.className.split(' ')[0]}`
                : element.tagName.toLowerCase();
            found.push(`${name} [${Math.round(box.left)}, ${Math.round(box.right)}]`);
          }
          if (element.shadowRoot) {
            walk(element.shadowRoot);
          }
        }
      };
      walk(document);
      return found;
    }, 320);

    expect(offenders).toEqual([]);
  });

  it('loads the embed widget in the iframe, not the demo page itself', async () => {
    page = await openAt(375);

    // The iframe sits inside the widest panel on the page, so what it renders
    // decides whether the measurements above mean anything. Serving the SPA for
    // `/embed/` would nest the whole demo inside itself and still "pass".
    const frame = await (await page.waitForSelector('iframe', { timeout: TIMEOUT })).contentFrame();
    expect(frame).toBeTruthy();
    await frame?.waitForSelector('nostr-timeline', { timeout: TIMEOUT });

    expect(await frame?.$('.page')).toBeNull();
  });

  it('keeps the timeline scroll area shorter than the screen', async () => {
    page = await openAt(375);

    // A nested scroll area taller than the viewport leaves no way to scroll
    // past it to the rest of the page.
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll('.timeline-scroll, .live')].map(
        (element) => element.getBoundingClientRect().height
      )
    );

    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) {
      expect(height).toBeLessThanOrEqual(800);
    }
  });
});
