// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the widget boots on mount.
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventActionDetail } from './lib/event-actions.ts';
import { acquireRelayHost, getRelayHostRefCount } from './lib/relay-host.ts';
import { makeEvent } from './test-fixtures.ts';

const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
/** The same event as POST_ID, written as NIP-19. */
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
const ALICE = 'bb0000000000000000000000000000000000000000000000000000000000000b';

/**
 * Verifies `<nostr-post>`'s side of the packaging contract: importing the entry
 * point defines it, its attributes reach the relay as the right REQs, and a
 * press on an embedder's button leaves the shadow root as a DOM event.
 */
describe('<nostr-post> custom element', () => {
  beforeAll(async () => {
    // Importing for the side effect is exactly how the embed bundle registers.
    await import('./embed-entry.ts');
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
  });

  /**
   * Put a post and its reactions into the cache the widget will read.
   *
   * Marked validated after saving, because the fixtures carry a fake `sig` and
   * the relay runs a lazy validation pass every 5s that *deletes* whatever
   * fails to verify. Without this the tests below pass on their own and time
   * out whenever the suite runs slowly enough for a pass to land mid-assertion.
   */
  async function seed(dbName: string, events: NostrEvent[]): Promise<void> {
    const host = await acquireRelayHost({ dbName });
    try {
      for (const event of events) {
        await host.storage.saveEvent(event);
      }
      await host.storage.markValidated(events.map((event) => event.id));
    } finally {
      await host.release();
    }
  }

  /** The fixture post, plus a ❤️ and a 🔥 on it. */
  function postWithReactions(): NostrEvent[] {
    return [
      makeEvent({ id: POST_ID, pubkey: ALICE, content: '詳細に出る投稿' }),
      makeEvent({ id: 'r1', pubkey: 'p1', kind: 7, content: '+', tags: [['e', POST_ID]] }),
      makeEvent({ id: 'r2', pubkey: 'p2', kind: 7, content: '🔥', tags: [['e', POST_ID]] }),
    ];
  }

  function mount(attributes: Record<string, string>): HTMLElement {
    const element = document.createElement('nostr-post');
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    document.body.appendChild(element);
    return element;
  }

  it('registers the element', () => {
    expect(customElements.get('nostr-post')).toBeDefined();
  });

  it('says so when no post was named, and boots no relay for it', async () => {
    const element = mount({});

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('表示する投稿が指定されていません') === true,
      'the "no post" notice'
    );
    // There is no sensible wider query for a detail view, so the widget asks
    // for nothing at all rather than falling back to one.
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('renders the post the cache holds, and its reactions', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());

    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('2 件のリアクション') === true,
      'the reaction total'
    );
  });

  it('opens exactly one reaction REQ, filtered on the post', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    mount({ 'event-id': POST_ID, 'db-name': dbName, 'reactions-limit': '25' });

    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');
    const host = await acquireRelayHost({ dbName });
    try {
      await waitFor(() => reactionSubscriptions(host).length === 1, 'the reaction REQ');
      expect(reactionSubscriptions(host)[0].filters).toEqual([
        { kinds: [7], '#e': [POST_ID], limit: 25 },
      ]);
    } finally {
      await host.release();
    }
  });

  it('opens no reaction REQ when reactions are turned off', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName, 'show-reactions': 'false' });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
    const host = await acquireRelayHost({ dbName });
    try {
      expect(reactionSubscriptions(host)).toHaveLength(0);
    } finally {
      await host.release();
    }
  });

  it('accepts a note1 for the same post', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, [makeEvent({ id: NOTE_HEX, pubkey: ALICE, content: 'bech32' })]);

    const element = mount({ 'event-id': NOTE, 'db-name': dbName });

    await waitFor(() => element.shadowRoot?.textContent?.includes('bech32') === true, 'the post');
  });

  it('renders an addressable post from author / kind / identifier', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    const article = makeEvent({
      id: 'cc00000000000000000000000000000000000000000000000000000000000003',
      pubkey: ALICE,
      kind: 30023,
      created_at: 1_700_000_100,
      tags: [['d', 'my-article']],
      content: '長文記事の本文',
    });
    await seed(dbName, [
      article,
      // A superseded version, so the newest is seen to win rather than the
      // first the relay happens to deliver.
      makeEvent({
        id: 'cc00000000000000000000000000000000000000000000000000000000000004',
        pubkey: ALICE,
        kind: 30023,
        created_at: 1_700_000_000,
        tags: [['d', 'my-article']],
        content: '古い版',
      }),
      makeEvent({
        id: 'r9',
        pubkey: 'p9',
        kind: 7,
        content: '+',
        tags: [['a', `30023:${ALICE}:my-article`]],
      }),
    ]);

    const element = mount({
      author: ALICE,
      kind: '30023',
      identifier: 'my-article',
      'db-name': dbName,
    });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('長文記事の本文') === true,
      'the article'
    );
    // NIP-25 points at an addressable event with an `a` tag, so the reaction
    // only lands if the element asked with `#a`.
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('1 件のリアクション') === true,
      'the reaction total'
    );
  });

  it('says the specification is wrong, not that none was given', async () => {
    const element = mount({ 'event-id': 'note1definitelynotarealnote' });

    // The two failures are different mistakes: an element with no attributes is
    // waiting for a page that sets one later, while this one is broken.
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('投稿の指定が正しくありません') === true,
      'the malformed-id notice'
    );
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('reports a post the relay does not have', async () => {
    const element = mount({
      'event-id': POST_ID,
      'db-name': `post-${crypto.randomUUID()}`,
    });

    // No upstream relays are configured, so the local relay answers with an
    // empty EOSE rather than hanging.
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('投稿が見つかりませんでした') === true,
      'the "not found" notice'
    );
  });

  it('raises nostr-timeline:action on a press, exactly as a timeline does', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({
      'event-id': POST_ID,
      'db-name': dbName,
      actions: '[{"id":"like","label":"いいね"}]',
    });

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (event) => {
      presses.push((event as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[data-action="like"]')),
      'the action button'
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>('button[data-action="like"]')?.click();

    // The same event name the timeline raises, so a page listening for one does
    // not have to learn a second.
    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('like');
    expect(presses[0].event.id).toBe(POST_ID);
  });

  it('starts up when the post is named after it is already on the page', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'db-name': dbName });
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('表示する投稿が指定されていません') === true,
      'the "no post" notice'
    );

    // The effect returns early while there is nothing to look up, and a page
    // that sets the attribute from script later must still get a widget — so
    // the early return has to happen *after* the target is read, or nothing
    // would ever re-run it.
    element.setAttribute('event-id', POST_ID);

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
  });

  it('releases the shared relay when removed', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });
    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');

    element.remove();
    await waitFor(() => getRelayHostRefCount() === 0, 'the relay host to be released');
  });
});

function reactionSubscriptions(host: {
  relay: unknown;
}): { id: string; filters: unknown[] }[] {
  const relay = host.relay as {
    subscriptionManager: { getAllSubscriptions(): { id: string; filters: unknown[] }[] };
  };
  return relay.subscriptionManager
    .getAllSubscriptions()
    .filter((subscription) => subscription.id.startsWith('reactions-'));
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}
