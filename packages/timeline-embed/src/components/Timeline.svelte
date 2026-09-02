<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type {
    AuthorAction,
    EventAction,
    EventActionContext,
    NoteAction,
  } from '../lib/event-actions.ts';
  import type { MaterialVariant } from '../lib/material-symbols.ts';
  import type { EmbedTarget, EmbeddedEvent } from '../lib/note-embeds.ts';
  import type { Profile } from '../lib/profile.ts';
  import { hasScrollableAncestor } from '../lib/scrollable.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import { whileVisible } from '../lib/when-visible.ts';
  import EventCard from './EventCard.svelte';

  interface Props {
    events: NostrEvent[];
    /** True once EOSE arrived, so an empty list means "really empty". */
    eose?: boolean;
    origins?: Map<string, EventOrigin>;
    validationStatuses?: Map<string, ValidationStatus>;
    /** Author profiles (kind 0), keyed by pubkey. */
    profiles?: Map<string, Profile>;
    /** Events quoted by a `nostr:` reference in a body, keyed by `embedKey`. */
    embeds?: Map<string, EmbeddedEvent>;
    /**
     * Render the diagnostic cache/upstream badge on each event. On by default
     * for direct users of this component (the demo site is one, and showing the
     * cache working is its whole point); `<nostr-timeline>` gates it behind its
     * `debug` attribute instead, so an embedded widget stays badge-free.
     */
    showOrigin?: boolean;
    /** Render author avatars. */
    showAvatars?: boolean;
    /**
     * Render image / video / audio attachments found in a note's body. On by
     * default; turning it off leaves the URLs in the text as links.
     */
    showMedia?: boolean;
    imageProxy?: string;
    /**
     * Render the events a `nostr:` reference in a body points at, as nested
     * cards. On by default; turning it off leaves the references as chips and
     * costs the relay nothing.
     */
    showEmbeds?: boolean;
    /**
     * Where to fetch a link preview for the first ordinary link in a body.
     * Undefined leaves previews off, which is the default everywhere.
     */
    ogpProxy?: string;
    /**
     * Buttons to render under every card. Empty by default — the widget ships
     * no actions of its own, only the mechanism (`lib/event-actions.ts`).
     */
    actions?: EventAction[];
    /**
     * Makes the author's avatar and name on every card pressable, under this
     * id. Undefined leaves both as they are.
     */
    authorAction?: AuthorAction;
    /** Makes the quote cards in every card's body pressable, under this id. */
    noteAction?: NoteAction;
    /** Called on a press, after the action's own `onSelect`. */
    onAction?: (
      action: EventAction | AuthorAction | NoteAction,
      context: EventActionContext
    ) => void;
    /** Render action icons as Material Symbols ligatures of this variant. */
    materialIcons?: MaterialVariant;
    /**
     * Called with an author's pubkey the first time one of their cards scrolls
     * into view, so profiles are fetched for what the reader actually sees.
     */
    onAuthorVisible?: (pubkey: string) => void;
    /**
     * Called with the lookup for a `nostr:` reference the first time the nested
     * card standing for it appears on screen.
     */
    onEmbedRequest?: (target: EmbedTarget) => void;
    /** A page of older events is on its way. */
    loadingOlder?: boolean;
    /** Nothing older is left to ask for, so the end is not watched any more. */
    exhausted?: boolean;
    /**
     * Called each time the end of the list is reached, until `exhausted`.
     * Leaving it out is what turns the paging off: no sentinel is rendered.
     */
    onReachEnd?: () => void;
  }

  const {
    events,
    eose = false,
    origins = new Map(),
    validationStatuses = new Map(),
    profiles = new Map(),
    embeds = new Map(),
    showOrigin = true,
    showAvatars = true,
    showMedia = true,
    imageProxy,
    showEmbeds = true,
    ogpProxy,
    actions = [],
    authorAction,
    noteAction,
    onAction,
    materialIcons,
    onAuthorVisible,
    onEmbedRequest,
    loadingOlder = false,
    exhausted = false,
    onReachEnd,
  }: Props = $props();

  let sentinel: HTMLElement | undefined = $state();
  let atEnd = $state(false);
  let scrolled = $state(false);

  /**
   * Whether the reader has scrolled here at all. `IntersectionObserver` cannot
   * tell that from a sentinel that was on screen the whole time — which is what
   * an iframe sized to its content leaves behind on every first paint.
   */
  $effect(() => {
    if (!onReachEnd || scrolled) {
      return;
    }
    const noticeScroll = () => {
      scrolled = true;
    };
    // Captured, because a scroll on an inner container does not bubble.
    const options = { capture: true, passive: true } as const;
    window.addEventListener('scroll', noticeScroll, options);
    return () => window.removeEventListener('scroll', noticeScroll, options);
  });

  $effect(() => {
    if (!onReachEnd || !sentinel || !atEnd || !scrolled || loadingOlder || exhausted || !eose) {
      return;
    }
    // The reader scrolled something; this is whether it was anything the widget
    // sits in — see `scrollable.ts`.
    if (!hasScrollableAncestor(sentinel)) {
      return;
    }
    // Re-runs when the page lands and `loadingOlder` clears, so a sentinel still
    // on screen keeps going rather than stopping one page short.
    onReachEnd();
  });
</script>

<div class="timeline">
  {#if events.length === 0}
    <p class="empty">{eose ? 'イベントがありません' : '読み込み中…'}</p>
  {:else}
    <ul>
      {#each events as event, index (event.id)}
        <li>
          <EventCard
            {event}
            origin={showOrigin ? origins.get(event.id) : undefined}
            status={validationStatuses.get(event.id)}
            profile={profiles.get(event.pubkey)}
            {profiles}
            {validationStatuses}
            {embeds}
            showAvatar={showAvatars}
            {showMedia}
            {imageProxy}
            {showEmbeds}
            {ogpProxy}
            {actions}
            {authorAction}
            {noteAction}
            {onAction}
            {materialIcons}
            datePlacement={index === 0 ? 'below' : 'above'}
            onVisible={onAuthorVisible && (() => onAuthorVisible(event.pubkey))}
            {onEmbedRequest}
          />
        </li>
      {/each}
    </ul>
    {#if onReachEnd}
      <div
        class="sentinel"
        part="sentinel"
        bind:this={sentinel}
        use:whileVisible={(visible) => {
          atEnd = visible;
        }}
      >
        {#if loadingOlder}
          <p class="loading-more" part="loading-more">さらに読み込んでいます…</p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .timeline {
    display: block;
  }

  ul {
    list-style: none;
    margin: 0;
    /* Breathing room above the first card, nothing more: the tooltip that used
       to need 48px here now flips under the header on the first card instead
       (`datePlacement`), so this is free to be the small gap it looks like.
       --nt-tip-clearance is the name it had while it was clearance, still read
       so embeds that raised it keep the spacing they chose. */
    padding: var(--nt-list-padding-top, var(--nt-tip-clearance, 16px)) 0 0;
    display: flex;
    flex-direction: column;
    /* Cards read as one continuous feed, the way a Nostr client renders it.
       Raising --nt-gap turns them back into separated blocks. */
    gap: var(--nt-gap, 0);
  }

  /* Only between cards: a rule above the first one would box in the widget,
     which the embedding page has not asked for. */
  li + li {
    border-top: 1px solid var(--nt-separator, var(--nt-border, #e1e8ed));
  }

  .empty,
  .loading-more {
    margin: 0;
    padding: 16px;
    text-align: center;
    color: var(--nt-muted, #657786);
  }
</style>
