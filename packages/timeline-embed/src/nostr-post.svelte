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
   * `<nostr-post event-id="note1…">` — one post, with the reactions (NIP-25
   * kind 7) it received.
   *
   * A third element rather than a mode on `<nostr-timeline>`: folding them
   * together would need a precedence rule between `filters` and `event-id`,
   * with the failure mode that someone writes both and one is silently
   * ignored. Same reasoning that split `<nostr-follow-timeline>` off.
   *
   * Replies are not shown. Reactions are counted, never published — a page
   * that wants a working like button declares it in `actions` and acts on the
   * `nostr-timeline:action` event, exactly as under a timeline card.
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
     * The post to show: 64-character hex, or a NIP-19 `note1…` / `nevent1…` /
     * `naddr1…`.
     *
     * The one attribute with no usable default. There is no wider query to
     * fall back to — "some event" would put an arbitrary stranger's post on
     * the embedding page — so without it nothing is asked of the relay.
     */
    eventId?: string;
    /**
     * With {@link kind} and {@link identifier}: an `naddr` spelled out, for a
     * page holding the three parts but not the encoding. Ignored when
     * `event-id` is set.
     */
    author?: string;
    kind?: string;
    /** An absent one is the empty identifier, which NIP-01 allows. */
    identifier?: string;
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    dbName?: string;
    /**
     * Defaults to a day; `0` re-asks on every lookup. Worth more here than on
     * a timeline: a post with fifty reactors is fifty profile lookups, and this
     * is what keeps them local on a second visit.
     */
    profileFreshness?: string;
    /**
     * Never used by this element. It exists so a page that also carries a
     * `<nostr-follow-timeline>` can give both matching settings — they share
     * one relay, and the first to mount configures it.
     */
    followsFreshness?: string;
    /**
     * Renders the diagnostic cache/upstream badge. Typed as a boolean too
     * because a Svelte parent's bare `debug` sets the property, not the
     * attribute.
     */
    debug?: string | boolean;
    /** `"false"` hides avatars — the author's and the reactors'. */
    showAvatars?: string;
    /** `"false"` leaves media in the body as links. */
    showMedia?: string;
    /** `"false"` leaves a `nostr:` reference as a chip instead of a card. */
    showEmbeds?: string;
    /** `"false"` also stops the kind 7 subscription being opened at all. */
    showReactions?: string | boolean;
    /** Backfill size. Defaults to 200, capped at 500; more may arrive live. */
    reactionsLimit?: string;
    /**
     * Opens the largest reaction's reactor list straight away. Off by default:
     * each visible row costs a profile lookup.
     */
    reactionsOpen?: string | boolean;
    /**
     * Buttons under the post, as a JSON array of `{"id","label","icon"}` — or,
     * set as a property from JS, the array itself, whose entries may carry an
     * `onSelect`. The same declaration and the same `nostr-timeline:action`
     * event as under a timeline card.
     */
    actions?: string | EventAction[];
    /**
     * Render action icons as Material Symbols ligature names
     * (<https://fonts.google.com/icons>): `outlined` (the default for a bare
     * attribute), `rounded`, `sharp`. Also loads the font from Google Fonts,
     * because a shadow root cannot register one itself.
     */
    materialIcons?: string | boolean;
    /**
     * `google` (default) injects Google's stylesheet into `document.head`,
     * exposing the reader's IP to Google. `none` leaves the font to the page.
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

  // So a press can be announced to a page that wrote HTML rather than JS and
  // has no callback to receive it.
  const hostElement = $host();

  // The load is an effect rather than part of the derivation because it touches
  // `document.head`; `ensureMaterialSymbols` is idempotent per variant anyway.
  const iconVariant = $derived(parseMaterialVariant(materialIcons));

  $effect(() => {
    if (iconVariant && materialIconsFont !== 'none') {
      ensureMaterialSymbols(iconVariant);
    }
  });

  const target = $derived(parsePostTarget({ eventId, author, kind, identifier }));
  const wantsReactions = $derived(parseEnabled(showReactions));

  // Separates the two ways `target` comes back undefined: an element with no
  // attributes yet is waiting (a page may set `event-id` from script), while
  // one carrying a mistyped `note1…` is broken and must not be told that no
  // post was specified.
  const named = $derived(
    Boolean(eventId?.trim()) || Boolean(author?.trim()) || Boolean(kind?.trim())
  );
  const fatal = $derived(
    !target && named ? '投稿の指定が正しくありません（event-id を確認してください）' : undefined
  );

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

  // Deliberately not `$state`: nothing renders from it, and Svelte would read
  // `$state` here as a store subscription to the variable above.
  let controller: TimelineController | undefined;

  // Attributes are reactive: changing one rebuilds the controller, which
  // restarts the relay, so prefer setting them before the element is connected.
  $effect(() => {
    // Read before the early return, or a page setting `event-id` later would
    // never re-run this. The relay is not booted for a post that was not named.
    const current = target;
    if (!current) {
      return;
    }

    const active = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
        // Left undefined when unset so the host keeps its own default, and two
        // widgets that both omit it do not look like conflicting configurations.
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
      // No need to await `start`: the request queues until the socket is up and
      // the `connected` handler pumps it.
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
  {fatal}
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
