<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';

  interface Props {
    event: NostrEvent;
  }

  const { event }: Props = $props();

  function shortPubkey(pubkey: string): string {
    if (pubkey.length <= 16) {
      return pubkey;
    }
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }
</script>

<article class="panel event-card">
  <header>
    <span class="author" title={event.pubkey}>{shortPubkey(event.pubkey)}</span>
    <span class="meta">
      <span class="kind">kind {event.kind}</span>
      <time datetime={new Date(event.created_at * 1000).toISOString()}>
        {formatTime(event.created_at)}
      </time>
    </span>
  </header>
  <p class="content">{event.content}</p>
</article>

<style>
  .event-card {
    margin-bottom: 0;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }

  .author {
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .meta {
    display: flex;
    gap: 8px;
    align-items: baseline;
    color: #657786;
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .kind {
    background-color: #eff3f4;
    border-radius: 999px;
    padding: 2px 8px;
  }

  .content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
