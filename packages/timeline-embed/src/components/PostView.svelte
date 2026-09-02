<script lang="ts">
  /**
   * `TimelineView`'s counterpart for `<nostr-post>`: the banners and empty
   * states around one post.
   *
   * The post itself goes through the timeline's own `EventCard` rather than a
   * copy, so the action bar under a detail post is the timeline's bar down to
   * the `part` names a page styles it through.
   *
   * The thread below is descendants only. What sits above the post is reached
   * by pressing the card's 「返信先」 chip, which re-points the widget at the
   * parent — one post is the frame this component is built around, and the way
   * back is `onBack` rather than a second post on screen.
   */

  import type { NostrEvent } from '@nostr-cache/shared';
  import type {
    AuthorAction,
    EventAction,
    EventActionContext,
    NoteAction,
  } from '../lib/event-actions.ts';
  import type { MaterialVariant } from '../lib/material-symbols.ts';
  import type { EmbedTarget } from '../lib/note-embeds.ts';
  import type { PostTarget } from '../lib/post-target.ts';
  import { summarizeReactionEvents } from '../lib/reactions.ts';
  import { buildReplyTree } from '../lib/reply-tree.ts';
  import type { TimelineState } from '../lib/timeline-controller.ts';
  import EventCard from './EventCard.svelte';
  import ReactionBar from './ReactionBar.svelte';
  import ReplyTree from './ReplyTree.svelte';

  interface Props {
    state: TimelineState;
    /** `undefined` when nothing usable was named; see `post-target.ts`. */
    target?: PostTarget;
    /** Render the diagnostic cache/upstream badge on the card. */
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    imageProxy?: string;
    showEmbeds?: boolean;
    /**
     * Link preview proxy for the post itself. The thread does not get one:
     * a reply's links are context, and one proxy request per reply is a
     * cost the reader did not ask for.
     */
    ogpProxy?: string;
    /** Off also stops the element opening the kind 7 subscription at all. */
    showReactions?: boolean;
    /** Open the reactor list on first render. */
    reactionsOpen?: boolean;
    /** Off also stops the element opening any thread subscription at all. */
    showReplies?: boolean;
    /** Levels of the thread to render; matches what was subscribed to. */
    repliesDepth?: number;
    /**
     * Called with the parent's id when the 「返信先」 chip is pressed. Absent
     * leaves the chip the plain text it is on a timeline card.
     */
    onNavigate?: (id: string) => void;
    /** Rendered when there is somewhere to go back to; see `onNavigate`. */
    onBack?: () => void;
    /** The embedder's buttons, rendered under the post as on a card. */
    actions?: EventAction[];
    /**
     * Makes the people on screen pressable — every card's author, a quoted
     * note's header, a `nostr:` mention, a reactor's row. Unlike `actions` it
     * reaches the whole thread: it adds no row of its own.
     */
    authorAction?: AuthorAction;
    /**
     * Makes the quote cards pressable — in the post's body and in every reply's,
     * for the same reason `authorAction` reaches them: a quote is somebody
     * else's post either way, and the thread is mostly other people's.
     */
    noteAction?: NoteAction;
    /** Called on a press, after the action's own `onSelect`. */
    onAction?: (
      action: EventAction | AuthorAction | NoteAction,
      context: EventActionContext
    ) => void;
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
    imageProxy,
    showEmbeds = true,
    ogpProxy,
    showReactions = true,
    reactionsOpen = false,
    showReplies = true,
    repliesDepth,
    onNavigate,
    onBack,
    actions = [],
    authorAction,
    noteAction,
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

  // Derived for the same reason the reaction summary is: a reply landing
  // re-grows the thread without the controller knowing anything about NIP-10.
  const tree = $derived(
    target && showReplies
      ? buildReplyTree(state.replies.get(target.key) ?? [], target.match, {
          maxDepth: repliesDepth,
          // A reply to an article names the coordinate and the version its
          // author was reading; without the second, that `e` tag points at an
          // event the thread does not contain.
          ...(event ? { rootId: event.id } : {}),
        })
      : undefined
  );

  /**
   * A press on a reactor's row. The kind 7 rather than the post: `pubkey` says
   * who was pressed, the event is what that press rode in on. Its `status` is
   * always undefined — only what is drawn as a card is verified — which is the
   * "no verdict yet" every listener already handles.
   */
  function pressReactor(pubkey: string, reaction: NostrEvent): void {
    if (!authorAction) {
      return;
    }
    onAction?.(authorAction, {
      event: reaction,
      status: state.validationStatuses.get(reaction.id),
      pubkey,
    });
  }

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
    <!-- Outside the `{#if event}` on purpose: an ancestor the relay turns out
         not to hold is exactly the case where the reader most needs the way
         back, and there is no card to hang it off. -->
    {#if onBack}
      <button type="button" class="back" part="back" onclick={onBack}>
        ← 元の投稿に戻る
      </button>
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
          {imageProxy}
          {showEmbeds}
          {ogpProxy}
          {actions}
          {authorAction}
          {noteAction}
          {onAction}
          {materialIcons}
          {onEmbedRequest}
          {onNavigate}
          onVisible={onAuthorVisible && (() => onAuthorVisible(event.pubkey))}
        />
        {#if summary}
          <ReactionBar
            {summary}
            profiles={state.profiles}
            {showAvatars}
            {imageProxy}
            defaultOpen={reactionsOpen}
            onReactorVisible={onAuthorVisible}
            {authorAction}
            onAuthorPress={pressReactor}
          />
        {/if}
        {#if tree}
          <ReplyTree
            {tree}
            profiles={state.profiles}
            validationStatuses={state.validationStatuses}
            embeds={state.embeds}
            origins={state.origins}
            {showOrigin}
            {showAvatars}
            {showMedia}
            {imageProxy}
            {showEmbeds}
            {authorAction}
            {noteAction}
            {onAction}
            {onAuthorVisible}
            {onEmbedRequest}
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
    /* The post is the top of the widget, so the date tooltip opening above the
       header has nothing but the page to open into. 18px is what it takes to
       clear: a 26px tooltip 2px over a header that sits 10px into the card. */
    padding-top: var(--nt-post-padding-top, 18px);
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

  .back {
    display: inline-flex;
    align-items: center;
    margin: 0 0 8px;
    padding: var(--nt-back-padding, 4px 10px);
    border: 1px solid var(--nt-border, #e1e8ed);
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-back-bg, transparent);
    color: var(--nt-back-fg, var(--nt-muted, #657786));
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .back:hover {
    background: var(--nt-back-hover-bg, rgb(0 0 0 / 4%));
  }

  .back:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: 2px;
  }
</style>
