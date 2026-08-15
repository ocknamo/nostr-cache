/**
 * Post detail E2E.
 *
 * What only a real browser can check: the reactor list's profile lookups hang
 * off a real `IntersectionObserver`, so "a collapsed chip costs nothing" is
 * untestable in jsdom, where `whenVisible` reports immediately.
 *
 * The card and the action bar are the timeline's own components, already
 * covered by `timeline-embed.e2e.spec.ts`; what is asserted here is that this
 * element hands them the same things.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import { createTestEvent, getRandomSecret, noteBech32 } from '../../src/test-events.js';

const TIMEOUT = 20000;

describe('Post detail E2E', () => {
  let browser: Browser;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let page: Page | undefined;
  let dbCounter = 0;

  /** The post the widget is about. */
  let post: NostrEvent;
  /** A reply to it, so a reaction on the reply can be seen not to count. */
  let reply: NostrEvent;
  /**
   * A reply to the *reply*, naming nothing but its own parent.
   *
   * The point of the fixture: nothing except a second level of REQs can reach
   * it, because the post's own `#e` subscription has no tag here to match.
   */
  let grandchild: NostrEvent;
  /** Display name of the reactor whose profile is published. */
  const REACTOR_NAME = 'reacting alice';

  beforeAll(async () => {
    site = await startEmbedSiteServer();

    const author = getRandomSecret();
    post = await createTestEvent(author, {
      created_at: 1_700_000_000,
      tags: [],
      content: 'the post being read',
    });
    reply = await createTestEvent(author, {
      created_at: 1_700_000_100,
      tags: [['e', post.id]],
      content: 'a reply to it',
    });
    grandchild = await createTestEvent(author, {
      created_at: 1_700_000_150,
      // Deliberately without the thread root: the post's own `#e` subscription
      // then cannot match it at all, so it is on screen only if the second
      // level of REQs went out.
      tags: [['e', reply.id]],
      content: 'a reply to the reply',
    });

    /** A fresh key each time, so every reactor is a different person. */
    const reactTo = async (target: NostrEvent, content: string, extra: string[][] = []) =>
      createTestEvent(getRandomSecret(), {
        kind: 7,
        created_at: 1_700_000_200,
        tags: [...extra, ['e', target.id], ['p', target.pubkey]],
        content,
      });

    // One reactor whose profile is published too, so the list can be seen both
    // to resolve a name and to fall back to a shortened pubkey.
    const namedSeckey = getRandomSecret();
    const namedReaction = await createTestEvent(namedSeckey, {
      kind: 7,
      created_at: 1_700_000_300,
      tags: [['e', post.id]],
      content: '+',
    });
    const namedProfile = await createTestEvent(namedSeckey, {
      kind: 0,
      created_at: 1_700_000_500,
      tags: [],
      content: JSON.stringify({ display_name: REACTOR_NAME, picture: site.avatarUrl }),
    });

    // One person reacting twice with the same glyph, which must count once.
    const twiceSeckey = getRandomSecret();
    const twice = await Promise.all(
      [1_700_000_600, 1_700_000_700].map((created_at) =>
        createTestEvent(twiceSeckey, {
          kind: 7,
          created_at,
          tags: [['e', post.id]],
          content: '+',
        })
      )
    );

    const reactions = [
      namedReaction,
      // A different person, spelling the same thing the other way: `+` and a
      // literal ❤️ share one chip.
      await reactTo(post, '❤️'),
      await reactTo(post, '🔥'),
      ...twice,
      // A reaction to the *reply*, carrying the post's id first as NIP-10
      // threading does: delivered by `#e`, but its last `e` tag is the reply.
      await reactTo(reply, '🔥', [['e', post.id]]),
    ];

    upstream = await startMockUpstreamRelay([post, reply, grandchild, ...reactions, namedProfile]);
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

  /** The post embed page, pointed at the fixture post. */
  function postUrl(params: Record<string, string> = {}): string {
    dbCounter += 1;
    const search = new URLSearchParams({
      'db-name': `e2e-post-${dbCounter}`,
      relays: upstream.url,
      // bech32 rather than hex, so the decode path is exercised end to end.
      'event-id': noteBech32(post.id),
      ...params,
    });
    return `${site.postEmbedUrl}?${search}`;
  }

  /** Wait until the post itself is on screen. */
  async function waitForPost(target: Page): Promise<void> {
    await target.waitForSelector('nostr-post .content', { timeout: TIMEOUT });
  }

  /** The reaction chips, as `[glyph, count]` pairs in rendered order. */
  function chips(target: Page): Promise<[string, string][]> {
    return target.$$eval('nostr-post .chip', (nodes) =>
      nodes.map((node) => [
        node.querySelector('.glyph')?.textContent?.trim() ?? '',
        node.querySelector('.count')?.textContent?.trim() ?? '',
      ])
    ) as Promise<[string, string][]>;
  }

  it(
    'renders the post it was given, with its reactions counted',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl());
      await waitForPost(page);

      expect(await page.$eval('nostr-post .content', (node) => node.textContent)).toContain(
        'the post being read'
      );
      // The post is the first card; the thread below is its own assertion.
      expect(await page.$eval('nostr-post .event-card', (node) => node.textContent)).toContain(
        'the post being read'
      );

      await page.waitForSelector('nostr-post .chip', { timeout: TIMEOUT });
      await page.waitForFunction(
        () =>
          (document.querySelector('nostr-post')?.shadowRoot?.querySelectorAll('.chip').length ??
            0) >= 2,
        undefined,
        { timeout: TIMEOUT }
      );

      // `+` and a literal ❤️ share a chip; the double reactor counts once; the
      // reaction to the reply counts nowhere.
      expect(await chips(page)).toEqual([
        ['❤️', '3'],
        ['🔥', '1'],
      ]);
      // The chips carry the counts; nothing repeats them in prose.
      expect(await page.$$('nostr-post .total')).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'looks up no reactor profile until the list is opened',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl());
      await waitForPost(page);
      await page.waitForSelector('nostr-post .chip', { timeout: TIMEOUT });

      // The assertion jsdom cannot make: there every row would be "visible" the
      // moment it existed.
      expect(await page.$$('nostr-post .reactor')).toHaveLength(0);

      await page.click('nostr-post .chip');

      const reactor = await page.waitForSelector('nostr-post .reactor .name', {
        timeout: TIMEOUT,
      });
      expect(await reactor.textContent()).toBeTruthy();
      // The published profile resolves to a name; the others stay shortened
      // pubkeys, which is still a row.
      await page.waitForFunction(
        (name) =>
          [
            ...(document.querySelector('nostr-post')?.shadowRoot?.querySelectorAll('.name') ?? []),
          ].some((node) => node.textContent?.trim() === name),
        REACTOR_NAME,
        { timeout: TIMEOUT }
      );
    },
    TIMEOUT
  );

  it(
    'opens the reactor list on load when asked to',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl({ 'reactions-open': 'true' }));
      await waitForPost(page);

      // Every reactor, whatever they sent, without a press.
      await page.waitForSelector('nostr-post .reactor', { timeout: TIMEOUT });
      await page.waitForFunction(
        () =>
          (document.querySelector('nostr-post')?.shadowRoot?.querySelectorAll('.reactor').length ??
            0) === 4,
        undefined,
        { timeout: TIMEOUT }
      );
    },
    TIMEOUT
  );

  it(
    'asks for no reactions at all when they are turned off',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl({ 'show-reactions': 'false' }));
      await waitForPost(page);

      expect(await page.$$('nostr-post .chip')).toHaveLength(0);
      expect(await page.$$('nostr-post .reactions')).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'renders the embedder actions and reports a press to the embedding page',
    async () => {
      page = await browser.newPage();
      await page.goto(
        postUrl({
          actions: JSON.stringify([
            { id: 'reply', label: '返信', icon: '💬' },
            { id: 'like', label: 'いいね', icon: '♡' },
          ]),
        })
      );
      await waitForPost(page);

      // The host page is the top-level document here, so its own `parent` is
      // itself and the message lands back on this window.
      await page.evaluate(() => {
        (window as unknown as { pressed: unknown[] }).pressed = [];
        window.addEventListener('message', (message) => {
          if ((message.data as { type?: string })?.type === 'nostr-timeline:action') {
            (window as unknown as { pressed: unknown[] }).pressed.push(message.data);
          }
        });
      });

      const buttons = await page.$$('nostr-post .action');
      // One card, so one bar, in the order they were declared.
      expect(buttons).toHaveLength(2);
      expect(await buttons[0].getAttribute('aria-label')).toBe('返信');

      await buttons[1].click();

      // `postMessage` delivers on a later task.
      await page.waitForFunction(
        () => (window as unknown as { pressed: unknown[] }).pressed.length > 0,
        undefined,
        { timeout: TIMEOUT }
      );
      const pressed = await page.evaluate(
        () =>
          (window as unknown as { pressed: { actionId: string; event: { id: string } }[] }).pressed
      );
      expect(pressed).toHaveLength(1);
      expect(pressed[0].actionId).toBe('like');
      // The same payload the timeline's own bar posts, down to the event.
      expect(pressed[0].event.id).toBe(post.id);
    },
    TIMEOUT
  );

  it(
    'shows the whole post rather than scrolling it inside the card',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl());
      await waitForPost(page);

      // A timeline card caps its height and scrolls the body; a detail view has
      // no feed underneath for a long post to push away.
      const card = await page.$eval('nostr-post .event-card', (node) => ({
        maxHeight: getComputedStyle(node).maxHeight,
        scrolls: node.scrollHeight > node.clientHeight + 1,
      }));
      expect(card.maxHeight).toBe('none');
      expect(card.scrolls).toBe(false);
    },
    TIMEOUT
  );

  it(
    'builds the thread a level at a time, reaching a reply the post cannot match',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl());
      await waitForPost(page);

      await page.waitForSelector('nostr-post .replies', { timeout: TIMEOUT });
      await page.waitForFunction(
        () =>
          document
            .querySelector('nostr-post')
            ?.shadowRoot?.textContent?.includes('a reply to the reply') === true,
        undefined,
        { timeout: TIMEOUT }
      );

      expect(await page.$eval('nostr-post .replies', (node) => node.textContent)).toContain(
        'a reply to it'
      );
      // The grandchild names only its parent, so it is here only because the
      // level 1 EOSE opened a level 2 asking about the reply's id.
      const nesting = await page.$eval('nostr-post .replies', (node) => {
        const branches = node.querySelectorAll('.branch');
        return {
          levels: branches.length,
          nested: branches[0]?.contains(branches[1] ?? null) ?? false,
          inner: branches[1]?.textContent ?? '',
        };
      });
      expect(nesting.levels).toBe(2);
      expect(nesting.nested).toBe(true);
      expect(nesting.inner).toContain('a reply to the reply');
      expect(nesting.inner).not.toContain('a reply to it');
    },
    TIMEOUT
  );

  it(
    'opens no thread at all with show-replies=false',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl({ 'show-replies': 'false' }));
      await waitForPost(page);

      // Waited on something that does arrive, so this is not just "too early".
      await page.waitForSelector('nostr-post .chip', { timeout: TIMEOUT });
      expect(await page.$$('nostr-post .replies')).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'walks up to the parent from a reply, and back again',
    async () => {
      page = await browser.newPage();
      await page.goto(postUrl({ 'event-id': noteBech32(reply.id) }));
      await waitForPost(page);

      await page.waitForSelector('nostr-post .ref-nav', { timeout: TIMEOUT });
      await page.click('nostr-post .ref-nav');

      await page.waitForFunction(
        () =>
          document
            .querySelector('nostr-post')
            ?.shadowRoot?.querySelector('.content')
            ?.textContent?.includes('the post being read') === true,
        undefined,
        { timeout: TIMEOUT }
      );
      // The parent's own reactions are subscribed to afresh, so arriving here
      // is not merely a re-render of what was already on screen.
      await page.waitForSelector('nostr-post .chip', { timeout: TIMEOUT });

      await page.click('nostr-post .back');
      await page.waitForFunction(
        () =>
          document
            .querySelector('nostr-post')
            ?.shadowRoot?.querySelector('.content')
            ?.textContent?.includes('a reply to it') === true,
        undefined,
        { timeout: TIMEOUT }
      );
      expect(await page.$$('nostr-post .back')).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'says so when the post is not anywhere to be found',
    async () => {
      page = await browser.newPage();
      const missing = await createTestEvent(getRandomSecret(), {
        created_at: 1_700_009_000,
        tags: [],
        content: 'never published',
      });
      await page.goto(postUrl({ 'event-id': missing.id }));

      await page.waitForSelector('nostr-post .empty', { timeout: TIMEOUT });
      expect(await page.$eval('nostr-post .empty', (node) => node.textContent?.trim())).toBe(
        '投稿が見つかりませんでした'
      );
    },
    TIMEOUT
  );
});
