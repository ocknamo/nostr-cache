<svelte:options
  customElement={{
    tag: 'nostr-follow-timeline',
    props: {
      pubkey: { attribute: 'pubkey' },
      relays: { attribute: 'relays' },
      kinds: { attribute: 'kinds' },
      limit: { attribute: 'limit' },
      maxFollows: { attribute: 'max-follows' },
      includeSelf: { attribute: 'include-self' },
      sinceDays: { attribute: 'since-days' },
      followsFreshness: { attribute: 'follows-freshness' },
      maxEvents: { attribute: 'max-events' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      debug: { attribute: 'debug' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
      showEmbeds: { attribute: 'show-embeds' },
      actions: { attribute: 'actions' },
      authorAction: { attribute: 'author-action' },
      authorActionLabel: { attribute: 'author-action-label' },
      noteAction: { attribute: 'note-action' },
      noteActionLabel: { attribute: 'note-action-label' },
      materialIcons: { attribute: 'material-icons' },
      materialIconsFont: { attribute: 'material-icons-font' },
    },
  }}
/>

<script lang="ts">
  /**
   * `<nostr-follow-timeline pubkey="npub1…">` — the home timeline of whoever
   * `pubkey` names: the posts of everyone they follow, per their NIP-02 kind 3.
   *
   * A separate element rather than an attribute on `<nostr-timeline>`. That one
   * already has `filters` and `authors`, and a third way to name authors would
   * need a precedence rule between all three — with the failure mode that
   * someone writes `filters` and has it silently ignored. Splitting them makes
   * `pubkey` required by construction and leaves nothing to disambiguate.
   */

  import TimelineView from './components/TimelineView.svelte';
  import {
    type EventAction,
    dispatchActionEvent,
    normalizeActions,
    normalizeAuthorAction,
    normalizeNoteAction,
  } from './lib/event-actions.ts';
  import { ensureMaterialSymbols, parseMaterialVariant } from './lib/material-symbols.ts';
  import { DEFAULT_MAX_FOLLOWS, followFilterSource } from './lib/follow-list.ts';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseEnabled,
    parseFreshness,
    parseKinds,
    parseLimit,
    parseMaxEvents,
    parseMaxFollows,
    parsePubkey,
    parseRelays,
    parseSinceDays,
  } from './lib/timeline-config.ts';

  interface Props {
    /**
     * Whose follow list to walk. hex, `npub` or `nprofile`.
     *
     * The one attribute with no usable default: there is no wider query to fall
     * back to that would not mean asking upstream for the global feed.
     */
    pubkey?: string;
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    /**
     * Comma-separated event kinds. Defaults to `1`.
     *
     * Adding `6` (reposts) renders badly: `EventCard` does not interpret them,
     * so a repost arrives as an empty card or raw JSON. See the README.
     */
    kinds?: string;
    /** Defaults to 50. */
    limit?: string;
    /** Safety valve for pathological lists, not a tuning knob — see `follow-list.ts`. */
    maxFollows?: string;
    includeSelf?: string | boolean;
    /**
     * Only show posts from the last N days. Off by default: it bounds the local
     * query, but a quiet follow list then renders as an empty timeline with no
     * way for the reader to tell that from "nobody posted".
     */
    sinceDays?: string;
    /** Defaults to an hour; `0` re-asks upstream on every load. */
    followsFreshness?: string;
    /**
     * Events the page-shared cache keeps before evicting the least recently
     * read. Defaults to 5000; `0` lets it grow without a ceiling. Profiles and
     * follow lists are evicted last, so the freshness windows keep working.
     */
    maxEvents?: string;
    dbName?: string;
    /** Defaults to a day; `0` re-asks upstream on every lookup. */
    profileFreshness?: string;
    /** Renders the cache/upstream badges and the follow-truncation notice. */
    debug?: string | boolean;
    showAvatars?: string;
    showMedia?: string;
    /**
     * Set to "false" to leave a `nostr:` reference in a note's body as a chip
     * rather than fetching what it points at and rendering it nested, exactly
     * as on `<nostr-timeline>`.
     */
    showEmbeds?: string;
    /**
     * The embedder's buttons under every card, exactly as on
     * `<nostr-timeline>`: a JSON array from an attribute, or the array itself
     * (with `onSelect` functions) when set as a property. A press raises
     * `nostr-timeline:action` on this element.
     */
    actions?: string | EventAction[];
    /**
     * Makes the author's avatar and display name on every card pressable,
     * reported as the same `nostr-timeline:action` event under this id, with
     * the author's `pubkey` in the detail. Exactly as on `<nostr-timeline>`.
     */
    authorAction?: string;
    /**
     * The accessible name of that press. Defaults to 「プロフィールを開く」.
     */
    authorActionLabel?: string;
    /**
     * Makes the quote cards in a note's body pressable, reported as the same
     * `nostr-timeline:action` event under this id — with the **quoted** post in
     * `detail.event`. The way out of a quote, which carries no action row of
     * its own; the widget still navigates nowhere itself.
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
     * such as `favorite`, not literal text. Values: `outlined` (the default for
     * a bare attribute), `rounded`, `sharp`.
     *
     * Setting this also loads the font from Google Fonts into the page, because
     * a shadow root cannot register one itself — set
     * `material-icons-font="none"` when the page provides the font already.
     */
    materialIcons?: string | boolean;
    /**
     * Where the Material Symbols font comes from: `google` (default) injects
     * Google's stylesheet into `document.head`, which is a third-party request
     * exposing the reader's IP to Google. `none` loads nothing and leaves the
     * font to the embedding page.
     */
    materialIconsFont?: string;
  }

  const {
    pubkey,
    relays,
    kinds,
    limit,
    maxFollows,
    includeSelf,
    sinceDays,
    followsFreshness,
    maxEvents,
    dbName,
    profileFreshness,
    debug,
    showAvatars,
    showMedia,
    showEmbeds,
    actions,
    authorAction,
    authorActionLabel,
    noteAction,
    noteActionLabel,
    materialIcons,
    materialIconsFont,
  }: Props = $props();

  // The element itself, so a press reaches a page that only wrote HTML.
  const hostElement = $host();

  /**
   * The Material Symbols variant to render icons with, and the font to back it.
   *
   * The load is an effect rather than part of the derivation because it touches
   * `document.head`: deriving it would inject a stylesheet as a side effect of
   * reading a value, and once per re-render at that. `ensureMaterialSymbols` is
   * idempotent per variant regardless.
   */
  const iconVariant = $derived(parseMaterialVariant(materialIcons));

  $effect(() => {
    if (iconVariant && materialIconsFont !== 'none') {
      ensureMaterialSymbols(iconVariant);
    }
  });


  let state = $state<TimelineState>({
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    embeds: new Map(),
    reactions: new Map(),
    replies: new Map(),
    eose: false,
  });

  // Not `$state`: nothing renders from it, the visibility callback just needs
  // whichever controller is current when a card appears.
  let controller: TimelineController | undefined;

  // Derived rather than reported through `state` inside the effect below: an
  // effect that writes the same state it reads re-runs itself forever.
  const subject = $derived(parsePubkey(pubkey));

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. Prefer setting them before the element is connected.
  $effect(() => {
    if (!subject) {
      // Every other attribute survives a typo by falling back to a default.
      // This one cannot, so nothing is started at all — rather than quietly
      // showing someone else's timeline, or, far worse, everyone's.
      return;
    }

    const active = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
        // Left undefined when unset so the host keeps its own default rather
        // than this widget pinning one — which also keeps two widgets that both
        // omit the attribute from looking like conflicting configurations.
        profileFreshness: parseFreshness(profileFreshness),
        followsFreshness: parseFreshness(followsFreshness, 'follows-freshness'),
        storageMaxSize: parseMaxEvents(maxEvents),
      },
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start(
      followFilterSource({
        pubkey: subject,
        kinds: parseKinds(kinds),
        limit: parseLimit(limit),
        maxFollows: parseMaxFollows(maxFollows) ?? DEFAULT_MAX_FOLLOWS,
        includeSelf: parseEnabled(includeSelf),
        sinceSeconds: parseSinceDays(sinceDays),
      })
    );

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<TimelineView
  {state}
  fatal={subject ? undefined : 'pubkey が不正です（hex / npub / nprofile を指定してください）'}
  showOrigin={parseDebug(debug)}
  debug={parseDebug(debug)}
  showAvatars={showAvatars !== 'false'}
  showMedia={showMedia !== 'false'}
  showEmbeds={showEmbeds !== 'false'}
  actions={normalizeActions(actions)}
  authorAction={normalizeAuthorAction(authorAction, authorActionLabel)}
  noteAction={normalizeNoteAction(noteAction, noteActionLabel)}
  materialIcons={iconVariant}
  onAction={(action, context) => dispatchActionEvent(hostElement, action, context)}
  onAuthorVisible={(key) => controller?.requestProfile(key)}
  onEmbedRequest={(target) => controller?.requestEmbed(target)}
/>
