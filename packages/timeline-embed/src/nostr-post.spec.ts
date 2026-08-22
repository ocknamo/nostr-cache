// @vitest-environment jsdom
// fake-indexeddb backs the DexieStorage the widget boots on mount.
import 'fake-indexeddb/auto';
import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventActionDetail } from './lib/event-actions.ts';
import { acquireRelayHost, getRelayHostRefCount } from './lib/relay-host.ts';
import { makeEvent, seedValidated } from './test-fixtures.ts';

const POST_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
/** The same event as POST_ID, written as NIP-19. */
const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';
const NOTE_HEX = '5c04292b1080052d593c4b5f4e6f3ca0e0e0e5b76e5b3d0e0dcd4bcb1b6a7f11';
const ALICE = 'bb0000000000000000000000000000000000000000000000000000000000000b';
const BOB = 'cc0000000000000000000000000000000000000000000000000000000000000c';
const PARENT_ID = 'aa00000000000000000000000000000000000000000000000000000000000002';
const REPLY_ID = 'aa00000000000000000000000000000000000000000000000000000000000003';
const GRANDCHILD_ID = 'aa00000000000000000000000000000000000000000000000000000000000004';

/**
 * `<nostr-post>`'s packaging contract: the entry point defines it, its
 * attributes reach the relay as the right REQs, and a press leaves the shadow
 * root as a DOM event.
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

  async function seed(dbName: string, events: NostrEvent[]): Promise<void> {
    const host = await acquireRelayHost({ dbName });
    try {
      await seedValidated(host.storage, events);
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
    // No wider query to fall back to, so nothing is asked of the relay.
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
      () => element.shadowRoot?.querySelectorAll('.chip').length === 2,
      'the reaction chips'
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

  it('asks for the post before the watches around it', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    mount({ 'event-id': POST_ID, 'db-name': dbName });

    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');
    const host = await acquireRelayHost({ dbName });
    try {
      await waitFor(() => subscriptionsNamed(host, 'replies-').length === 1, 'all three REQs');
      // The relay reads for all three on the page's own thread, and the reaction
      // and thread filters read every row carrying the post's id — so the one
      // the reader is waiting to see has to be asked for first.
      expect(
        subscriptionsNamed(host, '')
          .map((subscription) => subscription.id)
          .filter((id) => !id.startsWith('profile-'))
      ).toEqual(['timeline-1:0', 'reactions-1:0', 'replies-1:0']);
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
      // Superseded, so the newest is seen to win rather than the first
      // delivered.
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
    // Only lands if the element asked with `#a`.
    await waitFor(
      () => element.shadowRoot?.querySelectorAll('.chip').length === 1,
      'the reaction chip'
    );
  });

  it('says the specification is wrong, not that none was given', async () => {
    const element = mount({ 'event-id': 'note1definitelynotarealnote' });

    // An element with no attributes is waiting for a page that sets one later;
    // this one is broken.
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

    // The same event name the timeline raises.
    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('like');
    expect(presses[0].event.id).toBe(POST_ID);
  });

  it('raises the same event for a quote press, carrying the quoted post', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, [
      makeEvent({ id: POST_ID, pubkey: ALICE, content: `引用する nostr:${NOTE}` }),
      makeEvent({ id: NOTE_HEX, pubkey: BOB, content: '引用された投稿' }),
    ]);
    const element = mount({
      'event-id': POST_ID,
      'db-name': dbName,
      'note-action': 'open-post',
      'note-action-label': '投稿へ',
    });

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (event) => {
      presses.push((event as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part="quote-open"]')),
      'the quote press target'
    );
    const open = element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="quote-open"]');
    expect(open?.getAttribute('aria-label')).toContain('投稿へ');
    open?.click();

    // The quoted post, not the one on screen: the press is the way to it.
    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('open-post');
    expect(presses[0].event.id).toBe(NOTE_HEX);
    // Nobody was pressed, so the field an author press carries stays off.
    expect('pubkey' in presses[0]).toBe(false);
  });

  it('raises the same event for an author press, naming who was pressed', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({
      'event-id': POST_ID,
      'db-name': dbName,
      'author-action': 'open-profile',
      'author-action-label': 'プロフィールへ',
    });

    const presses: EventActionDetail[] = [];
    element.addEventListener('nostr-timeline:action', (event) => {
      presses.push((event as CustomEvent<EventActionDetail>).detail);
    });

    await waitFor(
      () => Boolean(element.shadowRoot?.querySelector('button[part="author"]')),
      'the author press target'
    );
    const author = element.shadowRoot?.querySelector<HTMLButtonElement>('button[part="author"]');
    expect(author?.getAttribute('aria-label')).toContain('プロフィールへ');
    author?.click();

    // One event name for both kinds of press; the id is what tells them apart,
    // and `pubkey` is who to look up.
    expect(presses).toHaveLength(1);
    expect(presses[0].actionId).toBe('open-profile');
    expect(presses[0].pubkey).toBe(ALICE);
    expect(presses[0].event.id).toBe(POST_ID);
  });

  it('leaves the author unpressable without the attribute', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });

    await waitFor(() => Boolean(element.shadowRoot?.querySelector('.identity')), 'the author line');
    expect(element.shadowRoot?.querySelector('button[part="author"]')).toBeNull();
  });

  it('starts up when the post is named after it is already on the page', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'db-name': dbName });
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('表示する投稿が指定されていません') === true,
      'the "no post" notice'
    );

    // The early return has to happen *after* the target is read, or nothing
    // would re-run the effect.
    element.setAttribute('event-id', POST_ID);

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
  });

  it('opens exactly one thread REQ, filtered on the post', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    mount({ 'event-id': POST_ID, 'db-name': dbName, 'replies-limit': '25' });

    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');
    const host = await acquireRelayHost({ dbName });
    try {
      await waitFor(() => replySubscriptions(host).length === 1, 'the level 1 REQ');
      expect(replySubscriptions(host)[0].filters).toEqual([
        { kinds: [1], '#e': [POST_ID], limit: 25 },
      ]);
    } finally {
      await host.release();
    }
  });

  it('opens no thread REQ when replies are turned off', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName, 'show-replies': 'false' });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
    const host = await acquireRelayHost({ dbName });
    try {
      expect(replySubscriptions(host)).toHaveLength(0);
    } finally {
      await host.release();
    }
  });

  it('closes the thread REQ when replies are turned off after mount', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, postWithReactions());
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });
    await waitFor(() => getRelayHostRefCount() === 1, 'the relay host to be acquired');
    const host = await acquireRelayHost({ dbName });
    try {
      await waitFor(() => replySubscriptions(host).length === 1, 'the level 1 REQ');

      // Documented as not opening the subscription at all, so switching it off
      // has to close a REQ rather than merely stop rendering what it delivers.
      element.setAttribute('show-replies', 'false');

      await waitFor(() => replySubscriptions(host).length === 0, 'the level 1 REQ to close');
    } finally {
      await host.release();
    }
  });

  it('renders the thread the cache holds', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, [
      makeEvent({ id: POST_ID, pubkey: ALICE, content: '詳細に出る投稿' }),
      makeEvent({
        id: REPLY_ID,
        pubkey: BOB,
        content: '返信です',
        tags: [['e', POST_ID, '', 'root']],
      }),
      // Names only its parent besides the root, so nothing but the second level
      // of REQs can reach it.
      makeEvent({
        id: GRANDCHILD_ID,
        pubkey: BOB,
        content: '返信への返信です',
        tags: [
          ['e', POST_ID, '', 'root'],
          ['e', REPLY_ID, '', 'reply'],
        ],
      }),
    ]);

    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });

    await waitFor(
      () => element.shadowRoot?.textContent?.includes('返信への返信です') === true,
      'the grandchild'
    );
    expect(element.shadowRoot?.textContent).toContain('返信 2 件');
  });

  it('walks up to the parent without restarting the relay, and back again', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, [
      makeEvent({ id: PARENT_ID, pubkey: ALICE, content: '親の投稿' }),
      makeEvent({
        id: POST_ID,
        pubkey: BOB,
        content: '詳細に出る投稿',
        tags: [['e', PARENT_ID, '', 'reply']],
      }),
    ]);
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );

    // The one place the preview is checked against a real relay rather than a
    // seeded `embeds` map.
    await waitFor(
      () =>
        element.shadowRoot?.querySelector('.ref-nav')?.textContent?.includes('親の投稿') === true,
      'the reply target preview'
    );

    const chip = element.shadowRoot?.querySelector<HTMLButtonElement>('.ref-nav');
    expect(chip).toBeTruthy();
    chip?.click();

    // The body of the card on show, not the whole widget: the chip previews the
    // parent, so its text is on screen before anything is clicked. The first
    // `.note` in the tree is the shown post's — a chip sits outside it.
    await waitFor(() => shownNote(element)?.includes('親の投稿') === true, 'the parent');
    // The whole reason navigation goes through `showPost` rather than a new
    // controller: dropping the last reference stops the in-page relay and
    // starts it again between two posts of one conversation.
    expect(getRelayHostRefCount()).toBe(1);

    const back = element.shadowRoot?.querySelector<HTMLButtonElement>('.back');
    expect(back).toBeTruthy();
    back?.click();

    await waitFor(() => shownNote(element)?.includes('詳細に出る投稿') === true, 'the post again');
    expect(element.shadowRoot?.querySelector('.back')).toBeNull();
  });

  it('drops the way back when the page names a different post', async () => {
    const dbName = `post-${crypto.randomUUID()}`;
    await seed(dbName, [
      makeEvent({ id: PARENT_ID, pubkey: ALICE, content: '親の投稿' }),
      makeEvent({
        id: POST_ID,
        pubkey: BOB,
        content: '詳細に出る投稿',
        tags: [['e', PARENT_ID, '', 'reply']],
      }),
      makeEvent({ id: NOTE_HEX, pubkey: ALICE, content: 'bech32' }),
    ]);
    const element = mount({ 'event-id': POST_ID, 'db-name': dbName });
    await waitFor(
      () => element.shadowRoot?.textContent?.includes('詳細に出る投稿') === true,
      'the post'
    );
    element.shadowRoot?.querySelector<HTMLButtonElement>('.ref-nav')?.click();
    await waitFor(() => element.shadowRoot?.querySelector('.back') !== null, 'the way back');

    // A different post is a different conversation, so the walk into the old
    // one goes with it.
    element.setAttribute('event-id', NOTE);

    await waitFor(() => element.shadowRoot?.textContent?.includes('bech32') === true, 'the note');
    expect(element.shadowRoot?.querySelector('.back')).toBeNull();
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

/** The body of the post the widget is showing, ignoring its replies. */
function shownNote(element: HTMLElement): string | undefined {
  return element.shadowRoot?.querySelector('.post .note')?.textContent ?? undefined;
}

function subscriptionsNamed(
  host: { relay: unknown },
  prefix: string
): { id: string; filters: unknown[] }[] {
  const relay = host.relay as {
    subscriptionManager: { getAllSubscriptions(): { id: string; filters: unknown[] }[] };
  };
  return relay.subscriptionManager
    .getAllSubscriptions()
    .filter((subscription) => subscription.id.startsWith(prefix));
}

function reactionSubscriptions(host: { relay: unknown }): { id: string; filters: unknown[] }[] {
  return subscriptionsNamed(host, 'reactions-');
}

function replySubscriptions(host: { relay: unknown }): { id: string; filters: unknown[] }[] {
  return subscriptionsNamed(host, 'replies-');
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
