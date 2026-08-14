<script lang="ts">
  /**
   * The reactions a post received (NIP-25): one chip per distinct reaction,
   * opening to the list of who sent it.
   *
   * Deliberately *outside* the card rather than mixed into its action row. The
   * buttons there are the embedding page's, declared by id and label, so the
   * widget cannot know which — if any — is the like button, and a count hung
   * off a guess would land next to whatever happened to be called `like`.
   *
   * Pressing a chip opens the list and nothing else: the widget holds no key
   * and never publishes (`lib/event-actions.ts`).
   */

  import type { Profile } from '../lib/profile.ts';
  import type { ReactionSummary } from '../lib/reactions.ts';
  import ReactionList from './ReactionList.svelte';

  interface Props {
    summary: ReactionSummary;
    /** Every profile the widget has, keyed by pubkey. */
    profiles?: Map<string, Profile>;
    showAvatars?: boolean;
    /**
     * Open the largest chip on first render. Off by default: each visible row
     * costs a profile lookup, and a page embedding a post for its text should
     * not pay for them unasked.
     */
    defaultOpen?: boolean;
    onReactorVisible?: (pubkey: string) => void;
  }

  const {
    summary,
    profiles = new Map(),
    showAvatars = true,
    defaultOpen = false,
    onReactorVisible,
  }: Props = $props();

  /** Which chip's reactors are shown; only one opens at a time. */
  let openKey = $state<string | undefined>();

  // Seeded once rather than derived: the reader owns it afterwards, and
  // deriving would reopen the chip every time a new reaction changed `summary`.
  let seeded = false;
  $effect(() => {
    if (seeded || !defaultOpen) {
      return;
    }
    const first = summary.groups[0];
    if (first) {
      seeded = true;
      openKey = first.key;
    }
  });

  const openGroup = $derived(summary.groups.find((group) => group.key === openKey));

  function toggle(key: string): void {
    openKey = openKey === key ? undefined : key;
  }

  /**
   * `part` is a space-separated list and the key is a stranger's `content` —
   * `👍 いいね` is a legal kind 7 body, and interpolating it would publish
   * `いいね` as a part name an embedding page could match by accident.
   */
  function chipParts(key: string): string {
    return /\s/.test(key) ? 'reaction-chip' : `reaction-chip reaction-chip-${key}`;
  }
</script>

<!-- Nothing until a reaction arrives: an empty bar would be a row of furniture
     saying "0", on a widget whose reader cannot react. -->
{#if summary.total > 0}
  <section class="reactions" part="reactions">
    <div class="chips">
      {#each summary.groups as group (group.key)}
        <button
          type="button"
          class="chip"
          class:open={openKey === group.key}
          part={chipParts(group.key)}
          data-reaction={group.key}
          aria-expanded={openKey === group.key}
          aria-label="{group.label} {group.count} 件。リアクションしたユーザを表示"
          onclick={() => toggle(group.key)}
        >
          {#if group.url}
            <img
              class="glyph-image"
              src={group.url}
              alt={group.label}
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
          {:else}
            <!-- The button's own label already names the glyph and the count;
                 translate="no" because a glyph is not prose. -->
            <span class="glyph" translate="no" aria-hidden="true">{group.label}</span>
          {/if}
          <span class="count" aria-hidden="true">{group.count}</span>
        </button>
      {/each}
      {#if summary.hiddenGroups > 0}
        <!-- The chips are capped, the total is not. -->
        <span class="more" part="reaction-more">他 {summary.hiddenGroups} 種類</span>
      {/if}
    </div>
    <p class="total" part="reaction-total">{summary.total} 件のリアクション</p>
    {#if openGroup}
      <ReactionList
        reactors={openGroup.reactors}
        {profiles}
        {showAvatars}
        {onReactorVisible}
      />
    {/if}
  </section>
{/if}

<style>
  .reactions {
    display: block;
    padding: var(--nt-reactions-padding, 4px 12px 10px);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--nt-reaction-chip-gap, 6px);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: var(--nt-reaction-chip-padding, 2px 8px);
    border: 1px solid var(--nt-border, #e1e8ed);
    border-radius: var(--nt-reaction-chip-radius, 999px);
    background: var(--nt-reaction-chip-bg, transparent);
    color: var(--nt-muted, #657786);
    font: inherit;
    font-size: var(--nt-reaction-chip-font-size, 0.8rem);
    line-height: 1.6;
    cursor: pointer;
  }

  .chip:hover {
    background: var(--nt-reaction-chip-hover-bg, rgb(0 0 0 / 4%));
  }

  /* The open chip is the heading of the list below it. */
  .chip.open {
    border-color: var(--nt-reaction-chip-open-border, #8899a6);
    color: var(--nt-fg, #0f1419);
  }

  .chip:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: 2px;
  }

  .glyph {
    font-size: var(--nt-reaction-glyph-size, 1rem);
    line-height: 1;
  }

  .glyph-image {
    width: var(--nt-reaction-glyph-size, 1rem);
    height: var(--nt-reaction-glyph-size, 1rem);
    object-fit: contain;
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .more,
  .total {
    color: var(--nt-muted, #657786);
    font-size: var(--nt-reaction-chip-font-size, 0.8rem);
  }

  .total {
    margin: var(--nt-reaction-total-margin, 6px 0 0);
  }
</style>
