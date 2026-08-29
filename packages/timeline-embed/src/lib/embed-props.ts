/**
 * The attributes `<nostr-timeline>`, `<nostr-follow-timeline>` and
 * `<nostr-post>` share, and the wiring the three build from them.
 */

import {
  type AuthorAction,
  type EventAction,
  type NoteAction,
  normalizeActions,
  normalizeAuthorAction,
  normalizeNoteAction,
} from './event-actions.ts';
import {
  type MaterialVariant,
  ensureMaterialSymbols,
  parseMaterialVariant,
} from './material-symbols.ts';
import type { RelayHostConfig } from './relay-host.ts';
import { parseFreshness, parseMaxEvents, parseOgpProxy, parseRelays } from './timeline-config.ts';

export interface SharedEmbedProps {
  /** Comma-separated upstream relay URLs. Empty = cache-only. */
  relays?: string;
  /** IndexedDB database name for the page-shared cache. */
  dbName?: string;
  /**
   * Seconds a cached profile (kind 0) is shown before the relay re-asks
   * upstream. Defaults to a day; `0` re-asks on every lookup. Worth most on
   * `<nostr-post>`, where a post with fifty reactors is fifty lookups.
   */
  profileFreshness?: string;
  /**
   * Seconds a cached follow list (kind 3) is used before the relay re-asks
   * upstream; defaults to an hour, `0` re-asks on every load. Only
   * `<nostr-follow-timeline>` fetches one — the others take the attribute so a
   * page carrying both can spell the same setting, since they share one relay
   * and the first to mount configures it.
   */
  followsFreshness?: string;
  /**
   * Events the page-shared cache keeps before evicting the least recently read.
   * Defaults to 5000; `0` lets it grow without a ceiling. Profiles and follow
   * lists are evicted last, so the freshness windows keep working.
   */
  maxEvents?: string;
  /**
   * Set (`debug` / `debug="true"`) to render the diagnostic cache/upstream
   * badges, off by default, plus the follow-truncation notice on
   * `<nostr-follow-timeline>`. Typed as a boolean too because a Svelte parent's
   * bare `debug` sets the property rather than the attribute.
   */
  debug?: string | boolean;
  /**
   * Set to "false" to hide the avatars — the authors' and, on `<nostr-post>`,
   * the reactors'. Names are still fetched; this only stops the widget loading
   * images from whatever host a profile names.
   */
  showAvatars?: string;
  /**
   * Set to "false" to stop rendering images, video and audio found in a note's
   * body. The URLs stay in the text as links, so nothing is hidden — this only
   * stops the widget from fetching from whatever host a note names.
   */
  showMedia?: string;
  /**
   * Set to "false" to leave a `nostr:` reference in a note's body as an
   * abbreviated chip instead of fetching what it points at and rendering it
   * nested (NIP-27) — which is also the fallback for a reference that cannot be
   * fetched. Each nested card costs one lookup through the cache relay, up to
   * two per note and five levels deep.
   */
  showEmbeds?: string;
  /**
   * URL of the CORS proxy link previews (OGP) are fetched through, e.g.
   * `"https://corsproxy.io/?key=…"`. No default: **unset, or set without a
   * URL, means no previews and no requests**; see the README for what the
   * proxy gets to see.
   */
  ogpProxy?: string;
  /**
   * Buttons to render under every card, as a JSON array of
   * `{"id","label","icon"}` — or, set as a property from JS, the array itself,
   * whose entries may also carry an `onSelect`. The widget defines none of its
   * own: a press is reported as a `nostr-timeline:action` DOM event on the
   * element. See `lib/event-actions.ts`.
   */
  actions?: string | EventAction[];
  /**
   * Makes the people on screen pressable — a card's author, a quoted note's
   * header, a `nostr:` mention, and on `<nostr-post>` the reactors and the
   * whole thread — reported under this id with the pressed person in
   * `detail.pubkey`, which is not `detail.event.pubkey` outside the author.
   * Adds no row of its own, and navigates nowhere: the profile screen is the
   * embedding page's, and only that page holds the router.
   */
  authorAction?: string;
  /**
   * What pressing a person does, as the accessible name of that target.
   * Defaults to 「プロフィールを開く」 — set it when the press leads somewhere
   * else.
   */
  authorActionLabel?: string;
  /**
   * Makes the quote cards in a note's body pressable — the `nostr:` posts the
   * widget expands inline — under this id, with the **quoted** post in
   * `detail.event`. A quote is the one post on screen with no way out of its
   * own: the card around it carries `actions`, and a quote carries nothing.
   */
  noteAction?: string;
  /**
   * The label on that press, and its accessible name. Defaults to
   * 「投稿を開く」.
   */
  noteActionLabel?: string;
  /**
   * Render the action icons as Material Symbols
   * (<https://fonts.google.com/icons>): each `icon` is then a ligature name
   * such as `favorite`, not literal text. `outlined` (the default for a bare
   * attribute), `rounded`, `sharp`. Also loads the font from Google Fonts,
   * because a shadow root cannot register one itself.
   */
  materialIcons?: string | boolean;
  /**
   * Where that font comes from: `google` (default) injects Google's stylesheet
   * into `document.head`, exposing the reader's IP to Google. `none` loads
   * nothing and leaves the font to the embedding page.
   */
  materialIconsFont?: string;
}

/** What `TimelineView` and `PostView` both take, in their own spelling. */
export interface SharedViewProps {
  showAvatars: boolean;
  showMedia: boolean;
  showEmbeds: boolean;
  ogpProxy?: string;
  actions: EventAction[];
  authorAction?: AuthorAction;
  noteAction?: NoteAction;
  materialIcons?: MaterialVariant;
}

export function relayConfigFrom(props: SharedEmbedProps): RelayHostConfig {
  return {
    upstreamRelays: parseRelays(props.relays),
    dbName: props.dbName || undefined,
    // Left undefined when unset so the host keeps its own default rather than
    // one widget pinning it — which also keeps two widgets that both omit the
    // attribute from looking like conflicting configurations.
    profileFreshness: parseFreshness(props.profileFreshness),
    followsFreshness: parseFreshness(props.followsFreshness, 'follows-freshness'),
    storageMaxSize: parseMaxEvents(props.maxEvents),
  };
}

export function viewPropsFrom(props: SharedEmbedProps): SharedViewProps {
  return {
    showAvatars: props.showAvatars !== 'false',
    showMedia: props.showMedia !== 'false',
    showEmbeds: props.showEmbeds !== 'false',
    ogpProxy: parseOgpProxy(props.ogpProxy),
    actions: normalizeActions(props.actions),
    authorAction: normalizeAuthorAction(props.authorAction, props.authorActionLabel),
    noteAction: normalizeNoteAction(props.noteAction, props.noteActionLabel),
    materialIcons: parseMaterialVariant(props.materialIcons),
  };
}

/**
 * Call from an `$effect`, and with the variant {@link viewPropsFrom} already
 * parsed: it touches `document.head`, which a derivation would then do as a
 * side effect of reading a value — and parsing twice would warn twice.
 */
export function ensureIconFont(variant: MaterialVariant | undefined, font?: string): void {
  if (variant && font !== 'none') {
    ensureMaterialSymbols(variant);
  }
}
