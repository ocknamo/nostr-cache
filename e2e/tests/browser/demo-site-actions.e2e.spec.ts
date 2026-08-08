/**
 * Demo site action-bar E2E.
 *
 * The embed panel declares one list of buttons and hands it to six places: the
 * iframe's query string, the two live custom elements, and the three copyable
 * snippets. Nothing in the type system ties those together, so the failure this
 * guards against is drift — a list that reaches the live widgets while the
 * snippet a reader copies still produces a card with no buttons (or the other
 * way round), which is exactly the promise the panel makes about being "the
 * real thing".
 *
 * `embed-page.spec.ts` guards the same class of bug one layer down, between the
 * element's attributes and the iframe host page's forwarding list.
 *
 * Loads the built site, and needs no upstream relay: every assertion is about
 * what the page hands the widgets, not about events arriving.
 */

import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type DemoSiteServer, startDemoSiteServer } from '../../src/demo-site-server.js';

const TIMEOUT = 15000;

/** Any 64 hex characters: enough for the panel to mount the follow widget. */
const FOLLOW_PUBKEY = 'a'.repeat(64);

describe('Demo site action bar E2E', () => {
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

  async function open(): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const opened = await context.newPage();
    await opened.goto(site.baseUrl, { waitUntil: 'load' });
    // The embed panel mounts only once the page's relay is running.
    await opened.waitForSelector('nostr-timeline', { timeout: TIMEOUT });
    return opened;
  }

  /**
   * What the page handed a custom element.
   *
   * Read from the property as well as the attribute: Svelte sets a custom
   * element's props as properties when the element defines them, so the
   * attribute is empty on this path.
   */
  async function widgetActions(target: Page, tag: string): Promise<unknown> {
    const raw = await target.evaluate((selector) => {
      const element = document.querySelector(selector) as (Element & { actions?: unknown }) | null;
      return element?.actions ?? element?.getAttribute('actions');
    }, tag);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  it('gives the live widgets and the iframe the same buttons', async () => {
    page = await open();

    const fromElement = await widgetActions(page, 'nostr-timeline');
    // At least one button, or the assertions below would pass on an empty list.
    expect(Array.isArray(fromElement) && fromElement.length > 0).toBe(true);

    const iframeSrc = await page.getAttribute('iframe', 'src');
    const iframeParams = new URL(iframeSrc ?? '', site.baseUrl).searchParams;
    const iframeActions = iframeParams.get('actions');
    expect(iframeActions).not.toBeNull();
    expect(JSON.parse(iframeActions ?? '')).toEqual(fromElement);

    // The icons are Material Symbols ligature names, so the two examples only
    // look alike while both sides ask for the same variant: without it the
    // iframe would render the names as the words they are.
    const variant = await page.evaluate(() => {
      const element = document.querySelector('nostr-timeline') as
        | (Element & { materialIcons?: string })
        | null;
      return element?.materialIcons ?? element?.getAttribute('material-icons');
    });
    expect(variant).toBeTruthy();
    expect(iframeParams.get('material-icons')).toBe(variant);

    // The follow timeline renders only once the box holds a usable pubkey.
    await page.fill('.follow-input input', FOLLOW_PUBKEY);
    await page.waitForSelector('nostr-follow-timeline', { timeout: TIMEOUT });
    expect(await widgetActions(page, 'nostr-follow-timeline')).toEqual(fromElement);
  });

  it('declares the same buttons in every copyable snippet', async () => {
    page = await open();
    await page.fill('.follow-input input', FOLLOW_PUBKEY);
    await page.waitForSelector('nostr-follow-timeline', { timeout: TIMEOUT });

    const actions = (await widgetActions(page, 'nostr-timeline')) as { id: string }[];
    const snippets = await page.$$eval('.snippet code', (blocks) =>
      blocks.map((block) => block.textContent ?? '')
    );

    // iframe, Web Component and follow timeline: a missing one would let a
    // silently emptied snippet pass.
    expect(snippets.length).toBe(3);
    for (const snippet of snippets) {
      // The iframe snippet carries the list URL-encoded inside its `src`, the
      // other two write it inline as an HTML attribute. Decoding just that
      // parameter — rather than the whole snippet, which holds `%` signs of its
      // own — leaves all three comparable on the ids.
      const encoded = /[?&]actions=([^&"']+)/.exec(snippet);
      const declaration = encoded ? decodeURIComponent(encoded[1]) : snippet;
      for (const action of actions) {
        expect(declaration).toContain(`"id":"${action.id}"`);
      }
    }
  });
});
