<script lang="ts">
  /**
   * `TimelineView`'s counterpart for `<nostr-post>`: the banners and empty
   * states around one post.
   *
   * The post itself goes through the timeline's own `EventCard` rather than a
   * copy, so the action bar under a detail post is the timeline's bar down to
   * the `part` names a page styles it through.
   *
   * Replies are deliberately not rendered: a thread is a second subscription
   * and a layout of its own, and the post reads fine without one.
   */

  import type { EventAction, EventActionContext } from '../lib/event-actions.ts';
  import type { MaterialVariant } from '../lib/material-symbols.ts';
  import type { EmbedTarget } from '../lib/note-embeds.ts';
  import type { PostTarget } from '../lib/post-target.ts';
  import { summarizeReactionEvents } from '../lib/reactions.ts';
  import type { TimelineState } from '../lib/timeline-controller.ts';
  import EventCard from './EventCard.svelte';
  import ReactionBar from './ReactionBar.svelte';

  interface Props {
    state: TimelineState;
    /** `undefined` when nothing usable was named; see `post-target.ts`. */
    target?: PostTarget;
    /** Render the diagnostic cache/upstream badge on the card. */
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    showEmbeds?: boolean;
    /** Off also stops the element opening the kind 7 subscription at all. */
    showReactions?: boolean;
    /** Open the reactor list on first render. */
    reactionsOpen?: boolean;
    /** The embedder's buttons, rendered under the post as on a card. */
    actions?: EventAction[];
    /** Called on a press, after the action's own `onSelect`. */
    onAction?: (action: EventAction, context: EventActionContext) => void;
    /** Render action icons as Material Symbols ligatures of this variant. */
    materialIcons?: MaterialVariant;
    /** Rendered instead of everything else, unlike `state.error`. */
    fatal?: string;
    onAuthorVisible?: (pubkey: string) => void;
    onEmbedRequest?: (target: EmbedTarget) => void;
  }

  const {
    state,
    target,
    showOrigin = false,
    showAvatars = true,
    showMedia = true,
    showEmbeds = true,
    showReactions = true,
    reactionsOpen = false,
    actions = [],
    onAction,
    materialIcons,
    fatal,
    onAuthorVisible,
    onEmbedRequest,
  }: Props = $props();

  // An addressable target is answered by every version the relay holds, and the
  // timeline is ordered newest-first.
  const event = $derived(state.events[0]);

  // Derived rather than stored, so a reaction arriving re-counts the chips
  // without the controller knowing anything about NIP-25.
  const summary = $derived(
    target && showReactions
      ? summarizeReactionEvents(state.reactions.get(target.key) ?? [], target.match)
      : undefined
  );

  const notice = $derived(
    target === undefined
      ? '表示する投稿が指定されていません'
      : state.eose
        ? '投稿が見つかりませんでした'
        : '読み込み中…'
  );
</script>

<div class="widget" part="widget">
  {#if fatal}
    <p class="error" part="error">{fatal}</p>
  {:else}
    {#if state.error}
      <p class="error" part="error">{state.error}</p>
    {/if}
    <!-- Above the post rather than replacing it: rx-nostr re-issues the
         subscriptions, so what is on screen stays readable. -->
    {#if state.status === 'reconnecting'}
      <p class="reconnecting" part="reconnecting">リレーに再接続しています…</p>
    {/if}
    {#if event}
      <article class="post" part="post">
        <EventCard
          {event}
          origin={showOrigin ? state.origins.get(event.id) : undefined}
          status={state.validationStatuses.get(event.id)}
          profile={state.profiles.get(event.pubkey)}
          profiles={state.profiles}
          validationStatuses={state.validationStatuses}
          embeds={state.embeds}
          showAvatar={showAvatars}
          {showMedia}
          {showEmbeds}
          {actions}
          {onAction}
          {materialIcons}
          {onEmbedRequest}
          onVisible={onAuthorVisible && (() => onAuthorVisible(event.pubkey))}
        />
        {#if summary}
          <ReactionBar
            {summary}
            profiles={state.profiles}
            {showAvatars}
            defaultOpen={reactionsOpen}
            onReactorVisible={onAuthorVisible}
          />
        {/if}
      </article>
    {:else}
      <p class="empty" part="empty">{notice}</p>
    {/if}
  {/if}
</div>

<style>
  .widget {
    display: block;
    font-family: var(
      --nt-font,
      system-ui,
      -apple-system,
      'Segoe UI',
      'Helvetica Neue',
      sans-serif
    );
    font-size: var(--nt-font-size, 14px);
    background: var(--nt-bg, transparent);
    color: var(--nt-fg, #0f1419);
  }

  .post {
    display: block;
    /* A card in a feed scrolls its body past this height so one long post
       cannot push the others off screen; a detail view is the post, and an
       inner scrollbar inside a scrolling embed is the worst of both. Embeds
       that want a bounded box can set the property back to a length. */
    --nt-card-max-height: none;
  }

  .error {
    margin: 0 0 10px;
    padding: 8px 12px;
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-error-bg, #fdecea);
    color: var(--nt-error-fg, #a4262c);
    font-size: 0.85rem;
  }

  .reconnecting {
    margin: 0 0 10px;
    padding: 8px 12px;
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-notice-bg, #fff4e5);
    color: var(--nt-notice-fg, #8a5300);
    font-size: 0.85rem;
  }

  .empty {
    margin: 0;
    padding: 16px;
    text-align: center;
    color: var(--nt-muted, #657786);
  }
</style>
