// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the widget boots on mount.
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventActionDetail } from './lib/event-actions.ts';
import {
  DEFAULT_FOLLOWS_FRESHNESS,
  type RelayHost,
  acquireRelayHost,
  getRelayHostRefCount,
} from './lib/relay-host.ts';
import { makeEvent, seedValidated } from './test-fixtures.ts';

/** A distinct, valid 64-character hex pubkey per index. */
function hex(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(32);
}

const SUBJECT = hex(0xaa);
const FRIEND = hex(0x01);
/** A quotable event, and the NIP-19 spelling a body would reference it by. */
const QUOTED_NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const QUOTED_ID = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';

/**
 * The element's own contract: it resolves its authors from a kind 3 before it
 * subscribes, and every path where that fails ends with no subscription rather
 * than a widened one.
 *
 * Run cache-only (no upstream relays), so the events a spec seeds into storage
 * are the whole world the widget can see — which is what makes "it subscribed
 * for exactly these authors" a meaningful assertion.
 */
describe('<nostr-follow-timeline> custom element', () => {
  const originalWebSocket = globalThis.WebSocket;
  const seeded: RelayHost[] = [];

  beforeAll(async () => {
    // Importing for the side effect is exactly how the embed bundle registers.
    await import('./embed-entry.ts');
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    for (const host of seeded.splice(0)) {
      await host.release();
    }
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
    globalThis.WebSocket = originalWebSocket;
  });

  /** Put events into the cache the widget will read from. */
  async function seedCache(dbName: string, events: NostrEvent[]): Promise<void> {
    const host = await acquireRelayHost({ dbName });
    seeded.push(host);
    await seedValidated(host.storage, events);
  }

  function followList(pubkeys: string[], overrides: Partial<NostrEvent> = {}): NostrEvent {
    return makeEvent({
      id: `follows-${crypto.randomUUID()}`,
      kind: 3,
      pubkey: SUBJECT,
      tags: pubkeys.map((pubkey) => ['p', pubkey]),
      ...overrides,
    });
  }

  function mount(attributes: Record<string, string>): HTMLElement {
    const element = document.createElement('nostr-follow-timeline');
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    document.body.appendChild(element);
    return element;
  }

  /**
   * Filters of the widget's timeline subscription, once it has one.
   *
   * Joins and leaves the running host rather than holding it, so the reference
   * count keeps meaning "how many widgets are mounted".
   */
  async function timelineFilters(dbName: string): Promise<unknown[] | undefined> {
    const host = await acquireRelayHost({ dbName });
    try {
      const relay = host.relay as unknown as {
        subscriptionManager: { getAllSubscriptions(): { id: string; filters: unknown[] }[] };
      };
      return relay.subscriptionManager
        .getAllSubscriptions()
        .find((subscription) => subscription.id.startsWith('timeline-'))?.filters;
    } finally {
      await host.release();
    }
  }

  it('registers the element', () => {
    expect(customElements.get('nostr-follow-timeline')).toBeDefined();
  });

  it('subscribes for the authors named by the follow list', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      followList([FRIEND]),
      makeEvent({ id: 'note-1', pubkey: FRIEND, content: 'from a follow' }),
    ]);
    const element = mount({ pubkey: SUBJECT, 'db-name': dbName, 'include-self': 'false' });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('from a follow') === true,
      "the followed author's note"
    );
    expect(await timelineFilters(dbName)).toEqual([{ kinds: [1], authors: [FRIEND], limit: 50 }]);
  });

  it('accepts an npub for pubkey, the way an embedder copies one', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    // What matters is that a bech32 spelling reaches the kind 3 fetch as hex.
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
    const subject = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
    await seedCache(dbName, [followList([FRIEND], { pubkey: subject })]);
    mount({ pubkey: npub, 'db-name': dbName, 'include-self': 'false' });

    await waitFor(async () => (await timelineFilters(dbName)) !== undefined, 'the subscription');
    expect(await timelineFilters(dbName)).toEqual([{ kinds: [1], authors: [FRIEND], limit: 50 }]);
  });

  it('includes the subject unless told not to', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [followList([FRIEND])]);
    mount({ pubkey: SUBJECT, 'db-name': dbName });

    await waitFor(async () => (await timelineFilters(dbName)) !== undefined, 'the subscription');
    expect(await timelineFilters(dbName)).toEqual([
      { kinds: [1], authors: [FRIEND, SUBJECT], limit: 50 },
    ]);
  });

  it('opens no subscription and says so when there is no follow list', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    // Cache-only and nothing seeded: the kind 3 REQ answers with a bare EOSE,
    // which is the "never published it" case.
    const element = mount({ pubkey: SUBJECT, 'db-name': dbName });

    await waitFor(
      () =>
        element.shadowRoot?.textContent?.includes('フォローリストが見つかりませんでした') === true,
      'the missing-list notice'
    );
    // Above all: no filter was invented to replace the one that could not be built.
    expect(element.shadowRoot?.textContent).not.toContain('読み込み中');
    expect(await timelineFilters(dbName)).toBeUndefined();
  });

  it('opens no subscription when the follow list is empty', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [followList([])]);
    const element = mount({ pubkey: SUBJECT, 'db-name': dbName });

    await waitFor(
      () =>
        element.shadowRoot?.textContent?.includes('フォローリストが見つかりませんでした') === true,
      'the missing-list notice'
    );
    expect(await timelineFilters(dbName)).toBeUndefined();
  });

  it('refuses to subscribe with an unusable pubkey', async () => {
    const element = mount({ pubkey: 'not-a-pubkey' });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('pubkey が不正です') === true,
      'the invalid-pubkey message'
    );
    // Nothing was even started: `pubkey` is the one attribute with no default
    // that would not mean asking upstream for the global feed.
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('refuses to subscribe with no pubkey at all', async () => {
    const element = mount({});

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('pubkey が不正です') === true,
      'the invalid-pubkey message'
    );
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('honours kinds, limit and max-follows', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [followList([FRIEND, hex(2), hex(3)])]);
    mount({
      pubkey: SUBJECT,
      'db-name': dbName,
      kinds: '1,30023',
      limit: '5',
      'max-follows': '2',
      'include-self': 'false',
    });

    await waitFor(async () => (await timelineFilters(dbName)) !== undefined, 'the subscription');
    expect(await timelineFilters(dbName)).toEqual([
      { kinds: [1, 30023], authors: [FRIEND, hex(2)], limit: 5 },
    ]);
  });

  it('raises nostr-timeline:action for an author press, with the pubkey', async () => {
    // This element declares and forwards its attributes separately from
    // `<nostr-timeline>`, so the wiring is its own to get wrong.
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [
      followList([FRIEND]),
      makeEvent({ id: `post-${crypto.randomUUID()}`, pubkey: FRIEND, content: 'フォロー先の投稿' }),
    ]);
    const element = mount({
      pubkey: SUBJECT,
      'db-name': dbName,
      'author-action': 'open-profile',
      'author-action-label': 'プロフィールへ',
    });

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (press) => {
      presses.push((press as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part="author"]')),
      'the author press target'
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="author"]')?.click();

    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('open-profile');
    expect(presses[0].pubkey).toBe(FRIEND);
  });

  it('raises the same event for a quote press, carrying the quoted post', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    const quoted = makeEvent({ id: QUOTED_ID, pubkey: FRIEND, content: '引用された投稿' });
    await seedCache(dbName, [
      followList([FRIEND]),
      quoted,
      makeEvent({
        id: `post-${crypto.randomUUID()}`,
        pubkey: FRIEND,
        content: `引用する nostr:${QUOTED_NOTE}`,
      }),
    ]);
    const element = mount({
      pubkey: SUBJECT,
      'db-name': dbName,
      'note-action': 'open-post',
    });

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (press) => {
      presses.push((press as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part="quote-open"]')),
      'the quote press target'
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="quote-open"]')?.click();

    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('open-post');
    expect(presses[0].event.id).toBe(quoted.id);
  });

  it('reports the truncation only under debug', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [followList([FRIEND, hex(2), hex(3)])]);
    // Side by side on one page, so the only difference between them is `debug`.
    const shared = { pubkey: SUBJECT, 'db-name': dbName, 'max-follows': '1' } as const;
    const quiet = mount({ ...shared, 'include-self': 'false' });
    const loud = mount({ ...shared, 'include-self': 'false', debug: 'true' });

    await waitFor(
      () => loud.shadowRoot?.textContent?.includes('3 人中 1 人を表示しています') === true,
      'the truncation notice'
    );
    expect(quiet.shadowRoot?.textContent).not.toContain('人を表示しています');
  });

  it('leaves no follow-list subscription behind', async () => {
    const dbName = `follow-${crypto.randomUUID()}`;
    await seedCache(dbName, [followList([FRIEND])]);
    const element = mount({ pubkey: SUBJECT, 'db-name': dbName });

    // The kind 3 REQ is opened by the filter source, outside the controller's
    // profile bookkeeping — the one subscription none of the existing teardown
    // paths would reach.
    const host = await acquireRelayHost({ dbName });
    seeded.push(host);
    const relay = host.relay as unknown as {
      subscriptionManager: { getAllSubscriptions(): { id: string }[] };
    };
    const subscriptionIds = () =>
      relay.subscriptionManager.getAllSubscriptions().map((subscription) => subscription.id);

    // The timeline subscription only exists once the follow list resolved, so
    // waiting for it proves the one-shot ran. Catching that one *while open* is
    // no longer possible: it closes on EOSE now that the relay orders EOSE
    // after delivery, which is a window too short to poll for.
    await waitFor(
      () => subscriptionIds().some((id) => id.startsWith('timeline-')),
      'the resolved timeline subscription'
    );
    expect(subscriptionIds().filter((id) => id.startsWith('oneshot-'))).toEqual([]);

    element.remove();
    await waitFor(() => subscriptionIds().length === 0, 'every subscription to close');
  });

  it('acquires the shared relay while mounted and releases it on removal', async () => {
    const element = mount({ pubkey: SUBJECT, 'db-name': `follow-${crypto.randomUUID()}` });
    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

    element.remove();
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
  });

  /**
   * The kind 3 window is the point of the whole exercise — it is what makes a
   * second load skip the upstream round trip the author set depends on — and
   * nothing on screen would show it if the wiring were dropped.
   */
  describe('follows-freshness attribute', () => {
    async function windowForKind3(followsFreshness: number): Promise<number | undefined> {
      const host = await acquireRelayHost({ followsFreshness });
      try {
        const gate = (host.relay as unknown as { freshnessGate?: { windows: Map<number, number> } })
          .freshnessGate;
        return gate?.windows.get(3);
      } finally {
        await host.release();
      }
    }

    it('passes the configured window to the relay', async () => {
      mount({ pubkey: SUBJECT, 'follows-freshness': '60' });
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await windowForKind3(60)).toBe(60);
    });

    it('falls back to the ten-minute default when the attribute is absent', async () => {
      mount({ pubkey: SUBJECT });
      await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

      expect(await windowForKind3(DEFAULT_FOLLOWS_FRESHNESS)).toBe(DEFAULT_FOLLOWS_FRESHNESS);
    });
  });
});

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = async () => {
      if (await predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
      } else {
        setTimeout(tick, 10);
      }
    };
    void tick();
  });
}
