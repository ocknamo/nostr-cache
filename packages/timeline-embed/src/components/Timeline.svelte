<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import EventCard from './EventCard.svelte';

  interface Props {
    events: NostrEvent[];
    /** True once EOSE arrived, so an empty list means "really empty". */
    eose?: boolean;
    origins?: Map<string, EventOrigin>;
    validationStatuses?: Map<string, ValidationStatus>;
    /** Render the cache/upstream badge on each event. */
    showOrigin?: boolean;
  }

  const {
    events,
    eose = false,
    origins = new Map(),
    validationStatuses = new Map(),
    showOrigin = true,
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
    gap: var(--nt-gap, 10px);
  }

  .empty {
    margin: 0;
    padding: 16px;
    text-align: center;
    color: var(--nt-muted, #657786);
  }
</style>
