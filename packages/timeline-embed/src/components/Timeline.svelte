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
  import type { ValidationStatus } from '../lib/validation-status.ts';
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
    /**
     * Render the events a `nostr:` reference in a body points at, as nested
     * cards. On by default; turning it off leaves the references as chips and
     * costs the relay nothing.
     */
    showEmbeds?: boolean;
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
    showEmbeds = true,
    actions = [],
    authorAction,
    noteAction,
    onAction,
    materialIcons,
    onAuthorVisible,
    onEmbedRequest,
  }: Props = $props();
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
            {showEmbeds}
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

  .empty {
    margin: 0;
    padding: 16px;
    text-align: center;
    color: var(--nt-muted, #657786);
  }
</style>
