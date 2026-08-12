/**
 * Nested quote E2E.
 *
 * A `nostr:` reference in a note's body is rendered as the quoted note itself
 * (NIP-27), and the widget's whole reason for laying a quote out differently
 * from a timeline card is a geometric one: a card indents its body past the
 * avatar column, and repeating that at every level would squeeze a five-deep
 * chain into a column of single words. Only a real browser can measure that, so
 * the layout claims are checked here rather than in jsdom.
 *
 * The chain is built deepest-first, because an event id is the hash of the
 * event — a note can only quote one that already exists.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import {
  createTestEvent,
  getRandomSecret,
  naddrBech32,
  noteBech32,
} from '../../src/test-events.js';

const TIMEOUT = 20000;
/** Matches MAX_EMBED_DEPTH in packages/timeline-embed/src/lib/note-embeds.ts. */
const MAX_EMBED_DEPTH = 5;

describe('Nested quotes E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;
  /** layer 0 is the timeline card; each layer quotes the next one down. */
  let chain: NostrEvent[] = [];
  /** A note quoting a long-form article by its `naddr` coordinate. */
  let addressQuote: NostrEvent;

  beforeAll(async () => {
    site = await startEmbedSiteServer();

    // One layer past the cap, so the deepest card rendered has a reference of
    // its own that must stay a chip.
    const depth = MAX_EMBED_DEPTH + 1;
    const seckey = getRandomSecret();
    const built: NostrEvent[] = [];
    for (let layer = depth; layer >= 0; layer--) {
      const quoted = built[0];
      built.unshift(
        await createTestEvent(seckey, {
          created_at: 1_700_000_000 + layer,
          content: quoted ? `layer ${layer} nostr:${noteBech32(quoted.id)}` : `layer ${depth}`,
          tags: [],
        })
      );
    }
    chain = built;

    // An `naddr` names a coordinate rather than an id, so it is answered by
    // whichever version of the article is current — a different code path
    // (`fetchLatestReplaceable`) from every quote above.
    const article = await createTestEvent(seckey, {
      kind: 30023,
      created_at: 1_700_001_000,
      tags: [['d', 'my-article']],
      content: 'the current article',
    });
    const staleArticle = await createTestEvent(seckey, {
      kind: 30023,
      created_at: 1_700_000_500,
      tags: [['d', 'my-article']],
      content: 'the superseded article',
    });
    addressQuote = await createTestEvent(seckey, {
      created_at: 1_700_002_000,
      tags: [],
      content: `read this nostr:${naddrBech32({
        kind: 30023,
        pubkey: article.pubkey,
        identifier: 'my-article',
      })}`,
    });

    upstream = await startMockUpstreamRelay([...chain, addressQuote, staleArticle, article]);
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

  /** The embed, subscribed to the head of the chain and nothing else. */
  function embedUrl(params: Record<string, string> = {}): string {
    dbCounter += 1;
    const search = new URLSearchParams({
      'db-name': `e2e-quotes-${dbCounter}`,
      relays: upstream.url,
      filters: JSON.stringify([{ ids: [chain[0].id] }]),
      ...params,
    });
    return `${site.embedUrl}?${search}`;
  }

  /**
   * Box geometry for each resolved quote and the body inside it, outermost
   * first. `:not(.loading)` skips the placeholder frame, which carries the same
   * class while its lookup is in flight.
   *
   * Read through the shadow root, which `page.$$eval`'s selector engine pierces
   * but `document.querySelectorAll` does not.
   */
  function quoteBoxes(target: Page) {
    return target.$$eval('nostr-timeline .quote:not(.loading)', (nodes) =>
      nodes.map((node) => {
        const frame = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const body = node.querySelector(':scope > .content')?.getBoundingClientRect();
        return {
          frameLeft: frame.left,
          frameWidth: frame.width,
          paddingLeft: Number.parseFloat(style.paddingLeft),
          borderLeft: Number.parseFloat(style.borderLeftWidth),
          bodyLeft: body?.left ?? Number.NaN,
          bodyWidth: body?.width ?? Number.NaN,
          text: node.querySelector(':scope > .content')?.textContent ?? '',
        };
      })
    );
  }

  it(
    'renders the quoted note inside the card, five levels deep and no further',
    async () => {
      page = await browser.newPage();
      await page.goto(embedUrl());

      await page.waitForSelector('nostr-timeline .quote:not(.loading)', { timeout: TIMEOUT });
      await page.waitForFunction(
        (expected) =>
          (document
            .querySelector('nostr-timeline')
            ?.shadowRoot?.querySelectorAll('.quote:not(.loading)').length ?? 0) >= expected,
        MAX_EMBED_DEPTH,
        { timeout: TIMEOUT }
      );

      const boxes = await quoteBoxes(page);
      expect(boxes).toHaveLength(MAX_EMBED_DEPTH);
      expect(boxes.map((box) => box.text)).toEqual([
        'layer 1',
        'layer 2',
        'layer 3',
        'layer 4',
        // The deepest card rendered still carries its own reference, which stays
        // the abbreviated chip it was before this feature existed.
        expect.stringMatching(/^layer 5 note1\w+…\w+$/),
      ]);
    },
    TIMEOUT
  );

  it(
    'starts the quoted body at the frame edge rather than past an avatar',
    async () => {
      page = await browser.newPage();
      await page.goto(embedUrl());
      await page.waitForFunction(
        (expected) =>
          (document
            .querySelector('nostr-timeline')
            ?.shadowRoot?.querySelectorAll('.quote:not(.loading)').length ?? 0) >= expected,
        MAX_EMBED_DEPTH,
        { timeout: TIMEOUT }
      );

      const boxes = await quoteBoxes(page);
      for (const box of boxes) {
        // The body's left edge is the frame's own padding and nothing more: an
        // avatar column would put another ~30px between them.
        expect(box.bodyLeft - box.frameLeft).toBeCloseTo(box.paddingLeft + box.borderLeft, 0);
        expect(box.bodyWidth).toBeCloseTo(
          box.frameWidth - 2 * (box.paddingLeft + box.borderLeft),
          0
        );
      }

      // Five levels cost the frames' padding and borders, and nothing else — so
      // the innermost note is still most of the card's width.
      const [outermost] = boxes;
      const innermost = boxes[boxes.length - 1];
      expect(innermost.bodyWidth).toBeGreaterThan(outermost.bodyWidth * 0.7);
    },
    TIMEOUT
  );

  it(
    'keeps a five-deep chain inside the card height cap',
    async () => {
      page = await browser.newPage();
      await page.goto(embedUrl());
      await page.waitForFunction(
        (expected) =>
          (document
            .querySelector('nostr-timeline')
            ?.shadowRoot?.querySelectorAll('.quote:not(.loading)').length ?? 0) >= expected,
        MAX_EMBED_DEPTH,
        { timeout: TIMEOUT }
      );
      // A cap the chain is certainly taller than, rather than a narrow viewport
      // the text happens to overflow: how much a chain wraps depends on the
      // quote frame's padding, so tightening that would silently stop this test
      // from testing anything. Custom properties cross the shadow boundary, so
      // the page can set it from outside.
      await page.addStyleTag({ content: 'nostr-timeline { --nt-card-max-height: 160px }' });

      const card = await page.$eval('nostr-timeline .event-card', (node) => {
        const note = node.querySelector('.note') as HTMLElement;
        return {
          height: node.getBoundingClientRect().height,
          noteScrolls: note.scrollHeight > note.clientHeight,
        };
      });

      // The quotes live inside the one scrolling box, so a chain grows the
      // scroll rather than the card.
      expect(card.height).toBeLessThanOrEqual(160);
      expect(card.noteScrolls).toBe(true);
    },
    TIMEOUT
  );

  it(
    'resolves an naddr quote to the current version of the article',
    async () => {
      page = await browser.newPage();
      await page.goto(embedUrl({ filters: JSON.stringify([{ ids: [addressQuote.id] }]) }));

      await page.waitForSelector('nostr-timeline .quote:not(.loading)', { timeout: TIMEOUT });
      const boxes = await quoteBoxes(page);

      expect(boxes.map((box) => box.text)).toEqual(['the current article']);
    },
    TIMEOUT
  );

  it(
    'leaves the reference as a chip and fetches nothing when embeds are off',
    async () => {
      page = await browser.newPage();
      await page.goto(embedUrl({ 'show-embeds': 'false' }));

      await page.waitForSelector('nostr-timeline .content', { timeout: TIMEOUT });
      const body = await page.$eval(
        'nostr-timeline .content',
        (node) => node.textContent?.trim() ?? ''
      );

      expect(body).toMatch(/^layer 0 note1\w+…\w+$/);
      expect(await page.$$('nostr-timeline .quote:not(.loading)')).toHaveLength(0);
    },
    TIMEOUT
  );
});
