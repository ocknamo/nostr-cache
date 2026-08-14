<script lang="ts">
  /**
   * Who reacted, and with what. Opened from a chip in `ReactionBar`.
   *
   * Profiles are fetched the way a card's author is — the row asks when it
   * appears — so a post with two hundred reactors does not open two hundred
   * lookups the reader will never scroll to.
   */

  import { type Profile, authorName } from '../lib/profile.ts';
  import type { Reaction } from '../lib/reactions.ts';
  import { whenVisible } from '../lib/when-visible.ts';
  import Avatar from './Avatar.svelte';

  interface Props {
    /** Newest first, already capped — see `MAX_REACTORS_PER_GROUP`. */
    reactors: Reaction[];
    /** Every profile the widget has, keyed by pubkey. */
    profiles?: Map<string, Profile>;
    /**
     * Off leaves the names, as `show-avatars` does on a card: it stops the
     * widget loading images from whatever host a profile names, it does not
     * hide who reacted.
     */
    showAvatars?: boolean;
    /** Called the first time a reactor's row appears. */
    onReactorVisible?: (pubkey: string) => void;
  }

  const { reactors, profiles = new Map(), showAvatars = true, onReactorVisible }: Props = $props();
</script>

<ul class="reactors" part="reactors">
  {#each reactors as reactor (reactor.id)}
    <li
      class="reactor"
      part="reactor"
      use:whenVisible={onReactorVisible && (() => onReactorVisible(reactor.pubkey))}
    >
      {#if showAvatars}
        <Avatar
          pubkey={reactor.pubkey}
          profile={profiles.get(reactor.pubkey)}
          name={authorName(reactor.pubkey, profiles.get(reactor.pubkey))}
        />
      {/if}
      <span class="name">{authorName(reactor.pubkey, profiles.get(reactor.pubkey))}</span>
      {#if reactor.url}
        <!-- Same hardening as an avatar; `safeImageUrl` has already refused
             everything but http(s). -->
        <img
          class="glyph-image"
          src={reactor.url}
          alt={reactor.label}
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
        />
      {:else}
        <!-- translate="no": a glyph or a `:shortcode:` is not prose. -->
        <span class="glyph" translate="no">{reactor.label}</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .reactors {
    list-style: none;
    margin: 0;
    padding: var(--nt-reactors-padding, 4px 0 0);
    display: flex;
    flex-direction: column;
    gap: var(--nt-reactors-gap, 2px);
    /* The list is capped at 50 rows; this keeps those from pushing the page
       around. `none` restores a list sized to its content. */
    max-height: var(--nt-reactors-max-height, 240px);
    overflow-y: auto;
  }

  .reactor {
    display: flex;
    align-items: center;
    gap: var(--nt-reactor-gap, 8px);
    padding: var(--nt-reactor-padding, 3px 4px);
    /* Smaller than a card's author avatar; `Avatar` reads it through the
       cascade. */
    --nt-avatar-size: var(--nt-reactor-avatar-size, 24px);
    --nt-avatar-radius: var(--nt-reactor-avatar-radius, 999px);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--nt-reactor-font-size, 0.85rem);
    color: var(--nt-fg, #0f1419);
  }

  .glyph {
    flex: none;
    font-size: var(--nt-reaction-glyph-size, 1rem);
    line-height: 1;
  }

  .glyph-image {
    flex: none;
    width: var(--nt-reaction-glyph-size, 1rem);
    height: var(--nt-reaction-glyph-size, 1rem);
    object-fit: contain;
  }
</style>
