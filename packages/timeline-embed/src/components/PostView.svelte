<script lang="ts">
  /**
   * One post, in full, with its reactions under it.
   *
   * The counterpart of `TimelineView` for `<nostr-post>`: it owns the banners
   * and the empty states, and hands the post itself to the very same
   * `EventCard` a timeline renders. That reuse is the point — the action bar
   * under a detail post has to be the timeline's bar, down to the `part` names
   * a page styles it through, so it is the timeline's component rather than a
   * copy that will drift.
   *
   * The one difference a detail view needs is height: a card in a list scrolls
   * its body past `--nt-card-max-height` so one long post cannot push the rest
   * of the feed off screen, and here there is no rest of the feed. Lifting the
   * cap is a custom property, not a prop.
   *
   * Replies are deliberately not rendered. A thread is a second subscription
   * and a set of layout questions of its own, and the post is useful without
   * one — so this shows the post and what people reacted to it with, and stops.
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
    /**
     * The post being shown. `undefined` means the element was given nothing
     * usable to look up, which is rendered as a notice rather than as a wider
     * query — see `post-target.ts`.
     */
    target?: PostTarget;
    /** Render the diagnostic cache/upstream badge on the card. */
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    showEmbeds?: boolean;
    /**
     * Render the reaction bar. Off leaves the post alone and, in the element,
     * also stops the kind 7 subscription being opened at all.
     */
    showReactions?: boolean;
    /** Open the largest reaction's reactor list on first render. */
    reactionsOpen?: boolean;
    /** The embedder's buttons, rendered under the post exactly as on a card. */
    actions?: EventAction[];
    /** Called on a press, after the action's own `onSelect`. */
    onAction?: (action: EventAction, context: EventActionContext) => void;
    /** Render action icons as Material Symbols ligatures of this variant. */
    materialIcons?: MaterialVariant;
    /**
     * A configuration error that stops the widget before it starts. Rendered
     * instead of everything else, unlike `state.error`.
     */
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

  /**
   * The subscription asks for one event, but an addressable target is answered
   * by every version the relay holds — and the timeline is ordered newest-first,
   * so the head is the one to show.
   */
  const event = $derived(state.events[0]);

  /**
   * Derived rather than stored, so one more reaction arriving re-counts the
   * chips without the controller knowing anything about NIP-25.
   */
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
    <!-- Shown above the post rather than replacing it: rx-nostr keeps retrying
         and re-issues the subscriptions, so what is on screen stays readable. -->
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
    /*
     * No height cap here, unlike a timeline card.
     *
     * `EventCard` scrolls its body past this height so that one long post in a
     * feed cannot push the others off screen. A detail view is the post — a
     * reader who opened it wants the whole thing, and an inner scrollbar inside
     * an embed that is itself scrolling is the worst of both. Embeds that do
     * want a bounded box can set the property back to a length.
     */
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
