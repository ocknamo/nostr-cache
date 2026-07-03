<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import EventCard from './EventCard.svelte';

  interface Props {
    events: NostrEvent[];
    eose: boolean;
  }

  const { events, eose }: Props = $props();
</script>

<section class="timeline" aria-label="タイムライン">
  {#if events.length === 0}
    <p class="empty">
      {eose ? 'イベントはまだありません。投稿するかフィルタを変更してください。' : '読み込み中…'}
    </p>
  {:else}
    {#each events as event (event.id)}
      <EventCard {event} />
    {/each}
  {/if}
</section>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    text-align: center;
    color: #657786;
    padding: 32px 0;
  }
</style>
