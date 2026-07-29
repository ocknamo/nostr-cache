<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';

  interface Props {
    event: NostrEvent;
    /** Where the event was served from. Hidden when undefined. */
    origin?: EventOrigin;
    /** The relay's persisted signature-verification verdict. */
    status?: ValidationStatus;
  }

  const { event, origin, status }: Props = $props();

  function shortPubkey(pubkey: string): string {
    return pubkey.length <= 16 ? pubkey : `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }
</script>

<article class="event-card">
  <header>
    <span class="author" title={event.pubkey}>
      {shortPubkey(event.pubkey)}
      {#if status === 'validated'}
        <span class="verified" title="署名検証済み" aria-label="署名検証済み" role="img">✓</span>
      {/if}
    </span>
    <span class="meta">
      {#if origin}
        <span
          class="origin {origin}"
          title={origin === 'cache'
            ? 'ローカルキャッシュ（IndexedDB）から配信'
            : '上流リレーから取得してキャッシュに充填'}
        >
          {origin === 'cache' ? 'cache' : 'upstream'}
        </span>
      {/if}
      <time datetime={new Date(event.created_at * 1000).toISOString()}>
        {formatTime(event.created_at)}
      </time>
    </span>
  </header>
  <p class="content">{event.content}</p>
</article>

<style>
  .event-card {
    padding: 12px 14px;
    border: 1px solid var(--nt-border, #e1e8ed);
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-card-bg, #fff);
    color: var(--nt-fg, #0f1419);
  }

  header {
    display: flex;
    align-items: baseline;
    /* Narrow screens cannot fit the pubkey and the metadata on one line, so let
       the metadata drop to its own line instead of overflowing the card. */
    flex-wrap: wrap;
    gap: 4px 8px;
    margin-bottom: 6px;
  }

  .author {
    font-weight: 700;
    font-family: var(--nt-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 0.85rem;
    /* The abbreviated pubkey is one token; breaking it mid-hex reads as two.
       Where even one line does not fit — a very narrow embed, or a host page
       that raised --nt-font-size — clip it rather than widen the card. */
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .verified {
    color: var(--nt-verified, #17bf63);
    font-weight: 700;
    margin-left: 2px;
  }

  .meta {
    display: flex;
    gap: 2px 8px;
    align-items: baseline;
    flex-wrap: wrap;
    /* Stay right-aligned even once it has wrapped onto its own line. */
    margin-left: auto;
    color: var(--nt-muted, #657786);
    font-size: 0.8rem;
  }

  .meta time {
    white-space: nowrap;
  }

  .origin {
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* The whole point of the widget: cache hits are visibly distinct. */
  .origin.cache {
    background: var(--nt-cache-bg, #e6f7ed);
    color: var(--nt-cache-fg, #0b7a3f);
  }

  .origin.upstream {
    background: var(--nt-upstream-bg, #eef2f8);
    color: var(--nt-upstream-fg, #4a5b73);
  }

  .content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
</style>
