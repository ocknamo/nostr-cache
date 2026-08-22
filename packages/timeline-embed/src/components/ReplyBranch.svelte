<script lang="ts">
  /**
   * One level of a thread, and by self-import every level under it.
   *
   * Depth is carried by the nesting rather than by a class per level, so the
   * indent is one rule that composes — the same shape `EmbeddedNote` uses for
   * quoted notes.
   *
   * The cards here carry no 「返信先」 chip at all: a reply's parent is the card
   * it is nested under, so the chip would repeat on every row what the indent
   * already says — and pressing one would navigate to something the reader can
   * see, losing their place for nothing.
   */

  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type {
    AuthorAction,
    EventAction,
    EventActionContext,
    NoteAction,
  } from '../lib/event-actions.ts';
  import type { EmbedTarget, EmbeddedEvent } from '../lib/note-embeds.ts';
  import type { Profile } from '../lib/profile.ts';
  import type { ReplyNode } from '../lib/reply-tree.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import EventCard from './EventCard.svelte';
  import Self from './ReplyBranch.svelte';

  interface Props {
    nodes: ReplyNode[];
    profiles?: Map<string, Profile>;
    validationStatuses?: Map<string, ValidationStatus>;
    embeds?: Map<string, EmbeddedEvent>;
    origins?: Map<string, EventOrigin>;
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    showEmbeds?: boolean;
    authorAction?: AuthorAction;
    noteAction?: NoteAction;
    onAction?: (
      action: EventAction | AuthorAction | NoteAction,
      context: EventActionContext
    ) => void;
    onAuthorVisible?: (pubkey: string) => void;
    onEmbedRequest?: (target: EmbedTarget) => void;
  }

  const {
    nodes,
    profiles = new Map(),
    validationStatuses = new Map(),
    embeds = new Map(),
    origins = new Map(),
    showOrigin = false,
    showAvatars = true,
    showMedia = true,
    showEmbeds = true,
    authorAction,
    noteAction,
    onAction,
    onAuthorVisible,
    onEmbedRequest,
  }: Props = $props();
</script>

<ul class="branch">
  {#each nodes as node (node.event.id)}
    <li class="reply" part="reply">
      <EventCard
        event={node.event}
        origin={showOrigin ? origins.get(node.event.id) : undefined}
        status={validationStatuses.get(node.event.id)}
        profile={profiles.get(node.event.pubkey)}
        {profiles}
        {validationStatuses}
        {embeds}
        showAvatar={showAvatars}
        {showMedia}
        {showEmbeds}
        showReplyRef={false}
        {authorAction}
        {noteAction}
        {onAction}
        onVisible={onAuthorVisible && (() => onAuthorVisible(node.event.pubkey))}
        {onEmbedRequest}
      />
      {#if node.children.length > 0}
        <Self
          nodes={node.children}
          {profiles}
          {validationStatuses}
          {embeds}
          {origins}
          {showOrigin}
          {showAvatars}
          {showMedia}
          {showEmbeds}
          {authorAction}
          {noteAction}
          {onAction}
          {onAuthorVisible}
          {onEmbedRequest}
        />
      {/if}
      {#if node.hiddenChildren > 0}
        <p class="more" part="reply-more">
          この返信にはさらに {node.hiddenChildren} 件の返信があります
        </p>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .branch {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--nt-reply-gap, 0);
  }

  /* Every level but the first is indented by the nesting, so the guide line is
     drawn by the child list rather than by the card it belongs to. */
  .reply > :global(.branch) {
    margin-top: var(--nt-reply-gap, 0);
    padding-inline-start: var(--nt-reply-indent, 16px);
    border-inline-start: 2px solid var(--nt-reply-guide, var(--nt-border, #e1e8ed));
  }

  .reply + .reply {
    border-top: 1px solid var(--nt-separator, var(--nt-border, #e1e8ed));
  }

  .more {
    margin: 0;
    padding: 4px 12px 8px var(--nt-reply-indent, 16px);
    color: var(--nt-muted, #657786);
    font-size: 0.8rem;
  }
</style>
