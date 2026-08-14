<svelte:options
  customElement={{
    tag: 'nostr-timeline',
    props: {
      relays: { attribute: 'relays' },
      filters: { attribute: 'filters' },
      kinds: { attribute: 'kinds' },
      authors: { attribute: 'authors' },
      limit: { attribute: 'limit' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      followsFreshness: { attribute: 'follows-freshness' },
      debug: { attribute: 'debug' },
      showOrigin: { attribute: 'show-origin' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
      showEmbeds: { attribute: 'show-embeds' },
      actions: { attribute: 'actions' },
      materialIcons: { attribute: 'material-icons' },
      materialIconsFont: { attribute: 'material-icons-font' },
    },
  }}
/>

<script lang="ts">
  import TimelineView from './components/TimelineView.svelte';
  import {
    type EventAction,
    dispatchActionEvent,
    normalizeActions,
  } from './lib/event-actions.ts';
  import { ensureMaterialSymbols, parseMaterialVariant } from './lib/material-symbols.ts';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseFilters,
    parseFreshness,
    parseRelays,
    parseShowOriginAlias,
  } from './lib/timeline-config.ts';

  interface Props {
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    /**
     * JSON array of NIP-01 filters, e.g.
     * `'[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]'`.
     *
     * They travel as a single REQ, so events matching any of them share one
     * timeline. Reaches the fields `kinds` / `authors` / `limit` cannot
     * (`since`, `until`, `ids`, tag filters), and takes precedence over all
     * three when it parses to at least one usable filter.
     */
    filters?: string;
    /** Comma-separated event kinds. Ignored when `filters` is set. Defaults to `1`. */
    kinds?: string;
    /** Comma-separated author pubkeys (hex). Ignored when `filters` is set. */
    authors?: string;
    /** Max events to request. Ignored when `filters` is set. Defaults to 50. */
    limit?: string;
    /** IndexedDB database name for the shared cache. */
    dbName?: string;
    /**
     * Seconds a cached profile (kind 0) is shown before the relay re-asks
     * upstream. Defaults to a day; `0` re-asks on every lookup.
     */
    profileFreshness?: string;
    /**
     * Seconds a cached follow list (kind 3) is used before the relay re-asks
     * upstream.
     *
     * This element never fetches one — it exists so a page that also carries a
     * `<nostr-follow-timeline>` can be given matching settings. Both widgets
     * share one relay and the first to mount configures it, so without this
     * attribute the conflict warning would name a setting the other element has
     * no way to spell.
     */
    followsFreshness?: string;
    /**
     * Set (`debug` / `debug="true"`) to render the diagnostic cache/upstream
     * badges. Off by default — they are for checking that the cache works, not
     * for the readers of the embedding page.
     *
     * Typed as a boolean too because a Svelte parent's bare `debug` sets the
     * property rather than the attribute.
     */
    debug?: string | boolean;
    /**
     * Deprecated spelling of `debug`, kept for embeds written before the badges
     * became opt-in. `show-origin="true"` still shows them; an absent attribute
     * no longer does.
     */
    showOrigin?: string | boolean;
    /**
     * Set to "false" to hide author avatars. Names are still fetched; this only
     * stops the widget from loading images from whatever host a profile names.
     */
    showAvatars?: string;
    /**
     * Set to "false" to stop rendering images, video and audio found in a
     * note's body. The URLs stay in the text as links, so nothing is hidden —
     * this only stops the widget from fetching from whatever host a note names.
     */
    showMedia?: string;
    /**
     * Set to "false" to stop rendering the events a `nostr:` reference in a
     * note's body points at as nested cards (NIP-27). The references then stay
     * abbreviated chips, as they were before the feature existed — which is
     * also what the widget falls back to for a reference it cannot fetch.
     *
     * Each nested card costs one lookup through the cache relay, up to two per
     * note and five levels deep, so this is the switch for an embed that wants
     * the timeline to ask for nothing but the timeline.
     */
    showEmbeds?: string;
    /**
     * Buttons to render under every card, as a JSON array of
     * `{"id","label","icon"}` — or, when set as a property from JS, the array
     * itself, whose entries may also carry an `onSelect` function.
     *
     * The widget defines no actions of its own; a press is reported as a
     * `nostr-timeline:action` DOM event on this element. See
     * `lib/event-actions.ts`.
     */
    actions?: string | EventAction[];
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
    relays,
    filters,
    kinds,
    authors,
    limit,
    dbName,
    profileFreshness,
    followsFreshness,
    debug,
    showOrigin,
    showAvatars,
    showMedia,
    showEmbeds,
    actions,
    materialIcons,
    materialIconsFont,
  }: Props = $props();

  // The element itself, so a press can be announced to the embedding page —
  // which, having written HTML rather than JS, has no callback to receive.
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
    eose: false,
  });

  // Deliberately not `$state`: nothing renders from it, the visibility callback
  // just needs whichever controller is current when a card appears. (It also
  // cannot be named alongside `$state` here — Svelte reads `$state` as a store
  // subscription to the `state` variable above.)
  let controller: TimelineController | undefined;

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. That is safe even when this is the only widget on the
  // page — `acquireRelayHost` waits for a host that is still shutting down
  // before starting its replacement — but it does restart the relay, so prefer
  // setting the attributes before the element is connected.
  $effect(() => {
    const active = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
        // Left undefined when unset so the host keeps its own default rather
        // than this widget pinning one — which also keeps two widgets that both
        // omit the attribute from looking like conflicting configurations.
        profileFreshness: parseFreshness(profileFreshness),
        followsFreshness: parseFreshness(followsFreshness, 'follows-freshness'),
      },
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start(parseFilters({ filters, kinds, authors, limit }));

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<TimelineView
  {state}
  showOrigin={parseDebug(debug) || parseShowOriginAlias(showOrigin)}
  debug={parseDebug(debug)}
  showAvatars={showAvatars !== 'false'}
  showMedia={showMedia !== 'false'}
  showEmbeds={showEmbeds !== 'false'}
  actions={normalizeActions(actions)}
  materialIcons={iconVariant}
  onAction={(action, context) => dispatchActionEvent(hostElement, action, context)}
  onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
  onEmbedRequest={(target) => controller?.requestEmbed(target)}
/>
