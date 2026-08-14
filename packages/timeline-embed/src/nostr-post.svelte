<svelte:options
  customElement={{
    tag: 'nostr-post',
    props: {
      eventId: { attribute: 'event-id' },
      author: { attribute: 'author' },
      kind: { attribute: 'kind' },
      identifier: { attribute: 'identifier' },
      relays: { attribute: 'relays' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      followsFreshness: { attribute: 'follows-freshness' },
      debug: { attribute: 'debug' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
      showEmbeds: { attribute: 'show-embeds' },
      showReactions: { attribute: 'show-reactions' },
      reactionsLimit: { attribute: 'reactions-limit' },
      reactionsOpen: { attribute: 'reactions-open' },
      actions: { attribute: 'actions' },
      materialIcons: { attribute: 'material-icons' },
      materialIconsFont: { attribute: 'material-icons-font' },
    },
  }}
/>

<script lang="ts">
  /**
   * `<nostr-post event-id="note1…">` — one post, in full, with the reactions it
   * received.
   *
   * A third element rather than a mode on `<nostr-timeline>`. That one is
   * configured with a filter and renders whatever matches; this one is
   * configured with an event and renders exactly it. Folding them together
   * would mean a precedence rule between `filters` and `event-id`, with the
   * failure mode that someone writes both and one is silently ignored — the
   * same reasoning that split `<nostr-follow-timeline>` off.
   *
   * What it shows beyond the card:
   *
   * - the reactions (NIP-25 kind 7), grouped by emoji, with a count each;
   * - who sent them, with their avatar and their glyph, when a chip is opened.
   *
   * What it does not show is replies. A thread needs a second subscription and
   * a layout of its own, and the post reads perfectly well without one, so it
   * is left for later rather than half-built here.
   *
   * Still read-only, like the rest of the widget: reactions are counted, never
   * published. A page that wants a working like button declares it in `actions`
   * and acts on the `nostr-timeline:action` event itself — the same buttons,
   * the same event, as under a timeline card.
   */

  import PostView from './components/PostView.svelte';
  import {
    type EventAction,
    dispatchActionEvent,
    normalizeActions,
  } from './lib/event-actions.ts';
  import { ensureMaterialSymbols, parseMaterialVariant } from './lib/material-symbols.ts';
  import { parsePostTarget } from './lib/post-target.ts';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseEnabled,
    parseFlag,
    parseFreshness,
    parseReactionsLimit,
    parseRelays,
  } from './lib/timeline-config.ts';

  interface Props {
    /**
     * The post to show: a 64-character hex id, or a NIP-19 `note1…`,
     * `nevent1…` or `naddr1…`.
     *
     * The one attribute with no usable default. There is no wider query to fall
     * back to — "some event" would put an arbitrary stranger's post on the
     * embedding page — so without it the element renders a notice and asks the
     * relay for nothing.
     */
    eventId?: string;
    /**
     * With {@link kind} and {@link identifier}: an addressable event's
     * coordinate spelled out, for a page that holds the three parts but never
     * encoded them as an `naddr`. Ignored when `event-id` is set.
     */
    author?: string;
    /** Event kind of the addressable target. Ignored when `event-id` is set. */
    kind?: string;
    /**
     * `d` tag of the addressable target. Ignored when `event-id` is set; an
     * absent one is read as the empty identifier, which NIP-01 allows.
     */
    identifier?: string;
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    /** IndexedDB database name for the shared cache. */
    dbName?: string;
    /**
     * Seconds a cached profile (kind 0) is shown before the relay re-asks
     * upstream. Defaults to a day; `0` re-asks on every lookup.
     *
     * It buys more here than on a timeline: a post with fifty reactors is fifty
     * profile lookups, and on a second visit this is what keeps them local.
     */
    profileFreshness?: string;
    /**
     * Seconds a cached follow list (kind 3) is used before the relay re-asks
     * upstream.
     *
     * This element never fetches one — it exists so a page that also carries a
     * `<nostr-follow-timeline>` can be given matching settings. Both widgets
     * share one relay and the first to mount configures it, so without this
     * attribute the conflict warning would name a setting this element has no
     * way to spell.
     */
    followsFreshness?: string;
    /**
     * Set (`debug` / `debug="true"`) to render the diagnostic cache/upstream
     * badge. Off by default — it is for checking that the cache works, not for
     * the readers of the embedding page.
     *
     * Typed as a boolean too because a Svelte parent's bare `debug` sets the
     * property rather than the attribute.
     */
    debug?: string | boolean;
    /**
     * Set to "false" to hide avatars, both the author's and the reactors'.
     * Names are still fetched; this only stops the widget from loading images
     * from whatever host a profile names.
     */
    showAvatars?: string;
    /**
     * Set to "false" to stop rendering images, video and audio found in the
     * post's body. The URLs stay in the text as links.
     */
    showMedia?: string;
    /**
     * Set to "false" to stop rendering the events a `nostr:` reference in the
     * body points at as nested cards (NIP-27). The references then stay
     * abbreviated chips.
     */
    showEmbeds?: string;
    /**
     * Set to "false" to hide the reaction bar — which also stops the kind 7
     * subscription being opened, so the post costs one REQ and nothing else.
     */
    showReactions?: string | boolean;
    /**
     * How many reactions to ask the relay to backfill. Defaults to 200 and is
     * capped at 500, which is also where the ones already received stop
     * accumulating. More may still arrive live.
     */
    reactionsLimit?: string;
    /**
     * Set (`reactions-open` / `reactions-open="true"`) to open the largest
     * reaction's reactor list straight away.
     *
     * Off by default: each visible row costs a profile lookup, and a page that
     * embeds a post for its text should not pay for them unasked.
     */
    reactionsOpen?: string | boolean;
    /**
     * Buttons to render under the post, as a JSON array of
     * `{"id","label","icon"}` — or, when set as a property from JS, the array
     * itself, whose entries may also carry an `onSelect` function.
     *
     * The same declaration, the same rendering and the same
     * `nostr-timeline:action` DOM event as under a timeline card, so a page
     * that already listens for one does not have to learn a second name.
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
    eventId,
    author,
    kind,
    identifier,
    relays,
    dbName,
    profileFreshness,
    followsFreshness,
    debug,
    showAvatars,
    showMedia,
    showEmbeds,
    showReactions,
    reactionsLimit,
    reactionsOpen,
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
   * reading a value. `ensureMaterialSymbols` is idempotent per variant anyway.
   */
  const iconVariant = $derived(parseMaterialVariant(materialIcons));

  $effect(() => {
    if (iconVariant && materialIconsFont !== 'none') {
      ensureMaterialSymbols(iconVariant);
    }
  });

  const target = $derived(parsePostTarget({ eventId, author, kind, identifier }));
  const wantsReactions = $derived(parseEnabled(showReactions));

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
  // just needs whichever controller is current when a row appears. (It also
  // cannot be named alongside `$state` here — Svelte reads `$state` as a store
  // subscription to the `state` variable above.)
  let controller: TimelineController | undefined;

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. That is safe even when this is the only widget on the
  // page — `acquireRelayHost` waits for a host that is still shutting down
  // before starting its replacement — but it does restart the relay, so prefer
  // setting the attributes before the element is connected.
  $effect(() => {
    // Nothing to ask for. Left without a controller rather than started with a
    // widened filter: `PostView` says so, and the relay is never booted for a
    // post that was never named.
    const current = target;
    if (!current) {
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
      },
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start([current.filter]);
    if (wantsReactions) {
      // Issued without waiting for `start`: the request queues until the socket
      // is up and the `connected` handler pumps it, exactly as a profile lookup
      // triggered before the connection would.
      active.requestReactions(current, parseReactionsLimit(reactionsLimit));
    }

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<PostView
  {state}
  {target}
  showOrigin={parseDebug(debug)}
  showAvatars={showAvatars !== 'false'}
  showMedia={showMedia !== 'false'}
  showEmbeds={showEmbeds !== 'false'}
  showReactions={wantsReactions}
  reactionsOpen={parseFlag(reactionsOpen)}
  actions={normalizeActions(actions)}
  materialIcons={iconVariant}
  onAction={(action, context) => dispatchActionEvent(hostElement, action, context)}
  onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
  onEmbedRequest={(embed) => controller?.requestEmbed(embed)}
/>
