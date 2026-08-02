<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
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
    /** Render the cache/upstream badge on each event. */
    showOrigin?: boolean;
    /** Render author avatars. */
    showAvatars?: boolean;
    /**
     * Called with an author's pubkey the first time one of their cards scrolls
     * into view, so profiles are fetched for what the reader actually sees.
     */
    onAuthorVisible?: (pubkey: string) => void;
  }

  const {
    events,
    eose = false,
    origins = new Map(),
    validationStatuses = new Map(),
    profiles = new Map(),
    showOrigin = true,
    showAvatars = true,
    onAuthorVisible,
  }: Props = $props();
</script>

<div class="timeline">
  {#if events.length === 0}
    <p class="empty">{eose ? 'イベントがありません' : '読み込み中…'}</p>
  {:else}
    <ul>
      {#each events as event (event.id)}
        <li>
          <EventCard
            {event}
            origin={showOrigin ? origins.get(event.id) : undefined}
            status={validationStatuses.get(event.id)}
            profile={profiles.get(event.pubkey)}
            showAvatar={showAvatars}
            onVisible={onAuthorVisible && (() => onAuthorVisible(event.pubkey))}
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
    padding: 0;
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
