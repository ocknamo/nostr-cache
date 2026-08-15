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
      showReplies: { attribute: 'show-replies' },
      repliesLimit: { attribute: 'replies-limit' },
      repliesDepth: { attribute: 'replies-depth' },
      actions: { attribute: 'actions' },
      materialIcons: { attribute: 'material-icons' },
      materialIconsFont: { attribute: 'material-icons-font' },
    },
  }}
/>

<script lang="ts">
  /**
   * `<nostr-post event-id="note1…">` — one post, with the reactions (NIP-25
   * kind 7) and the thread (NIP-10 kind 1) it received.
   *
   * A third element rather than a mode on `<nostr-timeline>`: folding them
   * together would need a precedence rule between `filters` and `event-id`,
   * with the failure mode that someone writes both and one is silently
   * ignored. Same reasoning that split `<nostr-follow-timeline>` off.
   *
   * The thread is descendants only; the post's own ancestors are reached by
   * pressing its 「返信先」 chip, which re-points this element at the parent
   * without tearing the relay down. Nothing is ever published — a page that
   * wants a working like or reply button declares it in `actions` and acts on
   * the `nostr-timeline:action` event, exactly as under a timeline card.
   */

  import { untrack } from 'svelte';
  import PostView from './components/PostView.svelte';
  import {
    type EventAction,
    dispatchActionEvent,
    normalizeActions,
  } from './lib/event-actions.ts';
  import { ensureMaterialSymbols, parseMaterialVariant } from './lib/material-symbols.ts';
  import { type PostTarget, parsePostTarget } from './lib/post-target.ts';
  import {
    type PostWatches,
    TimelineController,
    type TimelineState,
  } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseEnabled,
    parseFlag,
    parseFreshness,
    parseReactionsLimit,
    parseRelays,
    parseRepliesDepth,
    parseRepliesLimit,
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
     * Opens the reactor list straight away. Off by default: each visible row
     * costs a profile lookup.
     */
    reactionsOpen?: string | boolean;
    /** `"false"` also stops any thread subscription being opened at all. */
    showReplies?: string | boolean;
    /**
     * Backfill size for **one level** of the thread; every level asks for its
     * own. Defaults to 100, capped at 500.
     */
    repliesLimit?: string;
    /**
     * Levels of the thread to fetch and render, direct replies being the
     * first. Defaults to 3, capped at 5 — each level is a live subscription
     * and the relay allows one client 20.
     */
    repliesDepth?: string;
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
    showReplies,
    repliesLimit,
    repliesDepth,
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

  /** The post the attributes name — the root of any walk up the thread. */
  const attributeTarget = $derived(parsePostTarget({ eventId, author, kind, identifier }));
  const wantsReactions = $derived(parseEnabled(showReactions));
  const wantsReplies = $derived(parseEnabled(showReplies));

  // Separates the two ways `target` comes back undefined: an element with no
  // attributes yet is waiting (a page may set `event-id` from script), while
  // one carrying a mistyped `note1…` is broken and must not be told that no
  // post was specified.
  const named = $derived(
    Boolean(eventId?.trim()) || Boolean(author?.trim()) || Boolean(kind?.trim())
  );
  const fatal = $derived(
    !attributeTarget && named
      ? '投稿の指定が正しくありません（event-id を確認してください）'
      : undefined
  );

  /**
   * Ancestors walked up to, oldest first; the last one is what is on screen.
   * Empty means the post the attributes name.
   */
  let trail = $state.raw<PostTarget[]>([]);
  const target = $derived(trail.at(-1) ?? attributeTarget);

  /**
   * Ancestors one reader can walk through before the way back stops being a
   * way back. Trimmed from the front, so the most recent hops survive.
   */
  const MAX_TRAIL = 20;

  /**
   * Not called `state`: this element needs `$state` in more than one place, and
   * a local of that name is what `$state` reads as inside a Svelte component
   * (the auto-subscription of a store called `state`), which takes the rune away
   * from everything after the first use.
   */
  let snapshot = $state<TimelineState>({
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

  // Reactive so the effect below re-points a controller that has just been
  // rebuilt — `.raw` because nothing renders from it and a class instance is
  // not something to wrap in a deep proxy.
  let controller = $state.raw<TimelineController | undefined>(undefined);
  /**
   * The controller `start()` has run for. A plain `let`, because the effect
   * that writes it also reads it and must not re-run on the write.
   */
  let startedFor: TimelineController | undefined;

  /** What the post on screen is watched with, given the current attributes. */
  function watches(): PostWatches {
    return {
      ...(wantsReactions ? { reactions: { limit: parseReactionsLimit(reactionsLimit) } } : {}),
      ...(wantsReplies
        ? {
            replies: {
              limit: parseRepliesLimit(repliesLimit),
              maxDepth: parseRepliesDepth(repliesDepth),
            },
          }
        : {}),
    };
  }

  // The relay's lifetime. Deliberately keyed on *whether* a post was named
  // rather than on which one: walking up a thread must not drop the last
  // reference to the shared relay, which would stop it and boot it again
  // between two posts of the same conversation. Attributes other than the post
  // are still reactive here — changing one rebuilds the controller — so prefer
  // setting them before the element is connected.
  $effect(() => {
    // Read before the early return, or a page setting `event-id` later would
    // never re-run this. The relay is not booted for a post that was not named.
    if (!attributeTarget) {
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
        snapshot = next;
      },
    });

    controller = active;

    return () => {
      controller = undefined;
      startedFor = undefined;
      void active.stop();
    };
  });

  /** The attributes' post the current trail was walked from. */
  let trailRoot: string | undefined;

  // A page re-pointing `event-id` is naming a different conversation, so the
  // way back into the old one goes with it.
  $effect(() => {
    const root = attributeTarget?.key;
    untrack(() => {
      if (trailRoot !== root) {
        trailRoot = root;
        trail = [];
      }
    });
  });

  // Point the controller at whichever post is on screen. Depends on exactly
  // these two things — reading the attributes directly would re-subscribe when
  // an unrelated one changed.
  $effect(() => {
    const active = controller;
    const shown = target;
    if (!active || !shown) {
      return;
    }
    untrack(() => {
      const wants = watches();
      if (startedFor !== active) {
        // `start()` opens the timeline REQ itself, so `showPost` here as well
        // would issue it twice.
        startedFor = active;
        void active.start([shown.filter]);
        // No need to await it: the watches queue until the socket is up and the
        // `connected` handler pumps them.
        active.watchPost(shown, wants);
        return;
      }
      active.showPost(shown, wants);
    });
  });

  function navigate(id: string): void {
    const next = parsePostTarget({ eventId: id });
    if (!next || next.key === target?.key) {
      return;
    }
    trail = [...trail, next].slice(-MAX_TRAIL);
  }

  function back(): void {
    trail = trail.slice(0, -1);
  }
</script>

<PostView
  state={snapshot}
  {target}
  {fatal}
  showOrigin={parseDebug(debug)}
  showAvatars={showAvatars !== 'false'}
  showMedia={showMedia !== 'false'}
  showEmbeds={showEmbeds !== 'false'}
  showReactions={wantsReactions}
  reactionsOpen={parseFlag(reactionsOpen)}
  showReplies={wantsReplies}
  repliesDepth={parseRepliesDepth(repliesDepth)}
  actions={normalizeActions(actions)}
  materialIcons={iconVariant}
  onAction={(action, context) => dispatchActionEvent(hostElement, action, context)}
  onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
  onEmbedRequest={(embed) => controller?.requestEmbed(embed)}
  onNavigate={navigate}
  onBack={trail.length > 0 ? back : undefined}
/>
