/**
 * Secure-origin E2E for the embeddable timeline.
 *
 * The widget is published on GitHub Pages, which is https-only, and it asks the
 * page for `new WebSocket('ws://nostr-cache.invalid')` — a URL an https page
 * would normally refuse as mixed content. It works because
 * `WebSocketServerEmulator` replaces the constructor and hands back an
 * `EmulatedWebSocket` that never reaches the network stack, so the browser's
 * mixed-content check is never consulted.
 *
 * That is a load-bearing assumption for every deployment of this widget, and it
 * cannot be observed on http. This suite pins it down over real TLS.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../src/browser-launch.js';
import { type EmbedSiteServer, startEmbedSiteServer } from '../../src/embed-site-server.js';
import { type MockUpstreamRelay, startMockUpstreamRelay } from '../../src/mock-upstream-relay.js';
import {
  type SelfSignedCert,
  createSelfSignedCert,
  hasOpenssl,
} from '../../src/self-signed-cert.js';
import { createTestEvent } from '../../src/test-events.js';

const TIMEOUT = 15000;

describe('Embeddable timeline over https', async () => {
  // Skip rather than fail where openssl is unavailable; CI (ubuntu-latest) has it.
  const opensslAvailable = await hasOpenssl();

  let browser: Browser;
  let context: BrowserContext;
  let site: EmbedSiteServer;
  let upstream: MockUpstreamRelay;
  let cert: SelfSignedCert;
  let page: Page | undefined;

  beforeAll(async () => {
    if (!opensslAvailable) {
      return;
    }
    cert = await createSelfSignedCert();
    const events = await Promise.all([
      createTestEvent(undefined, { content: 'secure origin event', created_at: 1_700_000_100 }),
    ]);
    // The upstream must be wss:// too: that connection uses the real WebSocket,
    // which an https page does apply the mixed-content rule to.
    upstream = await startMockUpstreamRelay(events, { tls: { key: cert.key, cert: cert.cert } });
    site = await startEmbedSiteServer({ tls: { key: cert.key, cert: cert.cert } });
    browser = await launchBrowser();
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  });

  afterAll(async () => {
    await page?.close();
    await context?.close();
    await browser?.close();
    await site?.close();
    await upstream?.close();
    await cert?.cleanup();
  });

  it.skipIf(!opensslAvailable)('serves the widget from an https origin', async () => {
    page = await context.newPage();
    await page.goto(`${site.embedUrl}?db-name=e2e-https-1`);

    expect(new URL(page.url()).protocol).toBe('https:');
    const timeline = await page.waitForSelector('nostr-timeline .timeline', { timeout: TIMEOUT });
    expect(timeline).toBeTruthy();
  });

  it.skipIf(!opensslAvailable)(
    'intercepts the ws:// relay URL instead of letting it be blocked as mixed content',
    async () => {
      page = await context.newPage();
      await page.goto(`${site.embedUrl}?db-name=e2e-https-2`);
      await page.waitForSelector('nostr-timeline .timeline', { timeout: TIMEOUT });

      // Speak NIP-01 to the in-page relay from the https page. Reaching EOSE
      // proves the emulated socket opened; a mixed-content block would surface
      // as a constructor throw or an immediate error event.
      const result = await page.evaluate(
        (timeoutMs) =>
          new Promise<{ ok: boolean; reason?: string }>((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
            let socket: WebSocket;
            try {
              socket = new WebSocket('ws://nostr-cache.invalid');
            } catch (error) {
              clearTimeout(timer);
              resolve({ ok: false, reason: `constructor threw: ${(error as Error).message}` });
              return;
            }
            socket.onerror = () => {
              clearTimeout(timer);
              resolve({ ok: false, reason: 'socket error (blocked as mixed content?)' });
            };
            socket.onopen = () =>
              socket.send(JSON.stringify(['REQ', 'probe', { kinds: [1], limit: 5 }]));
            socket.onmessage = (message) => {
              const parsed = JSON.parse(String(message.data));
              if (parsed[0] === 'EOSE') {
                clearTimeout(timer);
                socket.close();
                resolve({ ok: true });
              }
            };
          }),
        TIMEOUT - 1000
      );

      expect(result).toEqual({ ok: true });
    }
  );

  it.skipIf(!opensslAvailable)(
    'reads through to an upstream relay and caches from a secure origin',
    async () => {
      page = await context.newPage();
      const url = `${site.embedUrl}?db-name=e2e-https-3&relays=${encodeURIComponent(upstream.url)}`;

      await page.goto(url);
      await waitForEventCount(page, 1);
      expect(await originBadges(page)).toEqual(['upstream']);

      await page.reload();
      await waitForEventCount(page, 1);
      expect(await originBadges(page)).toEqual(['cache']);
    }
  );
});

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

function originBadges(target: Page): Promise<string[]> {
  return target.$$eval('nostr-timeline .origin', (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? '')
  );
}
