<script lang="ts">
  /**
   * The thread under a post (`<nostr-post>` only).
   *
   * Descendants, not the whole conversation: what sits *above* the post is
   * reached through the card's 「返信先」 chip instead, which re-points the
   * widget rather than stacking ancestors nobody asked for on top.
   *
   * No action buttons under a reply. `actions` is what the embedding page
   * declared for the post it named, and repeating that row under every reply
   * would turn one deliberate control into a column of them.
   */

  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type { EmbedTarget, EmbeddedEvent } from '../lib/note-embeds.ts';
  import type { Profile } from '../lib/profile.ts';
  import type { ReplyTree } from '../lib/reply-tree.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import ReplyBranch from './ReplyBranch.svelte';

  interface Props {
    tree: ReplyTree;
    profiles?: Map<string, Profile>;
    validationStatuses?: Map<string, ValidationStatus>;
    embeds?: Map<string, EmbeddedEvent>;
    origins?: Map<string, EventOrigin>;
    /** Render the diagnostic cache/upstream badge on each reply. */
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    showEmbeds?: boolean;
    onAuthorVisible?: (pubkey: string) => void;
    onEmbedRequest?: (target: EmbedTarget) => void;
  }

  const {
    tree,
    profiles = new Map(),
    validationStatuses = new Map(),
    embeds = new Map(),
    origins = new Map(),
    showOrigin = false,
    showAvatars = true,
    showMedia = true,
    showEmbeds = true,
    onAuthorVisible,
    onEmbedRequest,
  }: Props = $props();
</script>

<!-- Nothing at all until something lands, as with the reaction bar: a heading
     over an empty list is furniture on a post that simply has no replies. -->
{#if tree.total > 0 || tree.orphans > 0}
  <section class="replies" part="replies">
    {#if tree.total > 0}
      <h2 class="heading" part="replies-heading">返信 {tree.total} 件</h2>
      <ReplyBranch
        nodes={tree.roots}
        {profiles}
        {validationStatuses}
        {embeds}
        {origins}
        {showOrigin}
        {showAvatars}
        {showMedia}
        {showEmbeds}
        {onAuthorVisible}
        {onEmbedRequest}
      />
    {/if}
    {#if tree.orphans > 0}
      <!-- Said out loud rather than swallowed. These are replies the relay
           delivered whose own parent never arrived — because it was deleted, or
           because it fell off a cap — and a thread that silently drops a subtree
           reads as one nobody ever wrote. -->
      <p class="note" part="replies-note">
        返信先が取得できなかった投稿が {tree.orphans} 件あります
      </p>
    {/if}
  </section>
{/if}

<style>
  .replies {
    display: block;
    padding: var(--nt-replies-padding, 8px 0 0);
    border-top: 1px solid var(--nt-separator, var(--nt-border, #e1e8ed));
  }

  .heading {
    margin: 0;
    padding: 0 12px 4px;
    color: var(--nt-muted, #657786);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .note {
    margin: 0;
    padding: 4px 12px 8px;
    color: var(--nt-muted, #657786);
    font-size: 0.8rem;
  }
</style>
