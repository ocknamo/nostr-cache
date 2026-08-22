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
  /** A note quoting one whose body carries a link. */
  let linkQuote: NostrEvent;

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

    // A quoted body with something already pressable in it, for the claim that
    // making the card a press target does not take that away.
    const linked = await createTestEvent(seckey, {
      created_at: 1_700_003_000,
      tags: [],
      content: 'see https://example.com/inside for more',
    });
    linkQuote = await createTestEvent(seckey, {
      created_at: 1_700_003_100,
      tags: [],
      content: `quoting nostr:${noteBech32(linked.id)}`,
    });

    upstream = await startMockUpstreamRelay([
      ...chain,
      addressQuote,
      staleArticle,
      article,
      linked,
      linkQuote,
    ]);
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
        // The text run sits inside `.quote-body` now, alongside any nested
        // `.embed` cards placed where their own reference sat in the text —
        // `:scope > .content` no longer reaches it directly.
        const content = node.querySelector(':scope > .quote-body > .content');
        const body = content?.getBoundingClientRect();
        return {
          frameLeft: frame.left,
          frameWidth: frame.width,
          paddingLeft: Number.parseFloat(style.paddingLeft),
          borderLeft: Number.parseFloat(style.borderLeftWidth),
          bodyLeft: body?.left ?? Number.NaN,
          bodyWidth: body?.width ?? Number.NaN,
          text: content?.textContent ?? '',
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
    'makes a quote card pressable as a whole, without swallowing what is inside it',
    async () => {
      // Only a real browser answers this: the press is an overlay over the
      // frame, and what it must *not* swallow — a nested quote's own press —
      // is a question about paint order.
      page = await browser.newPage();
      await page.goto(embedUrl({ 'note-action': 'open-post' }));
      // Down to the nested card's own header: `.quote` alone would also match
      // the placeholder frame a card wears while its lookup is in flight.
      // Written relative to the shadow root, which is where the DOM calls below
      // run; Playwright's own selectors get the host prefixed back on.
      const nested = '.quote:not(.loading) .embed .quote:not(.loading)';
      await page.waitForSelector(`nostr-timeline ${nested} > .quote-header`, { timeout: TIMEOUT });

      const layering = await page.$eval(
        'nostr-timeline .quote:not(.loading)',
        (quote, nestedSelector) => {
          const root = quote.getRootNode() as ShadowRoot;
          const box = (
            quote.querySelector(':scope > .open') as HTMLElement
          ).getBoundingClientRect();
          // The nested card's header, which the nested card's own press must
          // own rather than the outer one that is drawn under it.
          const inner = root.querySelector(`${nestedSelector} > .quote-header`) as HTMLElement;
          const innerBox = inner.getBoundingClientRect();
          const at = root.elementFromPoint(
            (innerBox.left + innerBox.right) / 2,
            (innerBox.top + innerBox.bottom) / 2
          );
          return {
            // Against the padding box, which is what `inset: 0` fills: the
            // frame's own border is the only part of the card left over.
            coversFrame:
              Math.abs(box.width - quote.clientWidth) < 1 &&
              Math.abs(box.height - quote.clientHeight) < 1,
            innerOwnsItself: at === inner.parentElement?.querySelector(':scope > .open'),
          };
        },
        nested
      );

      expect(layering.coversFrame).toBe(true);
      expect(layering.innerOwnsItself).toBe(true);

      // The host page is the top-level document, so the press it forwards to an
      // embedding page lands back here — see the action test in
      // timeline-embed.e2e.spec.ts.
      await page.evaluate(() => {
        (window as unknown as { pressed: string[] }).pressed = [];
        window.addEventListener('message', (message) => {
          const data = message.data as { type?: string; event?: { id: string } };
          if (data?.type === 'nostr-timeline:action' && data.event) {
            (window as unknown as { pressed: string[] }).pressed.push(data.event.id);
          }
        });
      });

      // Clicked by coordinate, over each card's own header: every card in this
      // chain holds another one, so the centre of an outer press target is a
      // point the inner card owns — which is the behaviour asserted above.
      const headers = await page.$$eval(
        `nostr-timeline .quote:not(.loading) > .quote-header, nostr-timeline ${nested} > .quote-header`,
        (nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
          })
      );
      for (const point of headers.slice(0, 2)) {
        await page.mouse.click(point.x, point.y);
      }

      // The press reaches this page as a `postMessage`, which is delivered on a
      // later task than the click that raised it.
      await page.waitForFunction(
        () => (window as unknown as { pressed: string[] }).pressed.length === 2,
        undefined,
        { timeout: TIMEOUT }
      );
      const pressed = await page.evaluate(
        () => (window as unknown as { pressed: string[] }).pressed
      );
      // Layer 1 is the card's own quote; layer 2 is the one quoted inside it.
      expect(pressed).toEqual([chain[1].id, chain[2].id]);
    },
    TIMEOUT
  );

  it(
    'leaves a link in the quoted body reachable under the press',
    async () => {
      page = await browser.newPage();
      await page.goto(
        embedUrl({ filters: JSON.stringify([{ ids: [linkQuote.id] }]), 'note-action': 'open-post' })
      );
      await page.waitForSelector('nostr-timeline .quote:not(.loading) .content a', {
        timeout: TIMEOUT,
      });

      // Hit testing rather than a click: the press covers the frame, so what
      // answers over the link is the whole question.
      const ownsItself = await page.$eval(
        'nostr-timeline .quote:not(.loading) .content a',
        (link) => {
          const box = link.getBoundingClientRect();
          const root = link.getRootNode() as ShadowRoot;
          return (
            root.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2) === link
          );
        }
      );

      expect(ownsItself).toBe(true);
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
