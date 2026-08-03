<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import { parseRefs } from '../lib/event-refs.ts';
  import { type Profile, authorHandle, authorName, shortPubkey } from '../lib/profile.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import Avatar from './Avatar.svelte';

  interface Props {
    event: NostrEvent;
    /** Where the event was served from. Hidden when undefined. */
    origin?: EventOrigin;
    /** The relay's persisted signature-verification verdict. */
    status?: ValidationStatus;
    /** The author's kind 0 profile, once it has been fetched. */
    profile?: Profile;
    /** Render the author's avatar. */
    showAvatar?: boolean;
    /**
     * Called once, when the card first enters the viewport. The timeline uses
     * this to look up the author's profile only for cards a reader can see.
     */
    onVisible?: () => void;
  }

  const { event, origin, status, profile, showAvatar = true, onVisible }: Props = $props();

  /**
   * Report the card's first appearance on screen, then stop watching.
   *
   * Falls back to reporting immediately where `IntersectionObserver` is missing
   * (jsdom, older browsers): the lookup being eager is a far better failure than
   * every author staying an anonymous pubkey.
   */
  function whenVisible(node: HTMLElement, callback?: () => void) {
    // Read through a mutable holder so `update` can swap the callback in: an
    // action captures its argument once, and the prop is optional, so a card
    // that gains an `onVisible` later would otherwise never report.
    let current = callback;
    let reported = false;

    const report = () => {
      if (reported || !current) {
        return;
      }
      reported = true;
      current();
    };

    if (typeof IntersectionObserver === 'undefined') {
      report();
      return {
        update: (next?: () => void) => {
          current = next;
          report();
        },
        destroy: () => {},
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          report();
        }
      },
      // Start the lookup just before the card arrives, so the name is usually
      // there by the time it is read rather than popping in afterwards.
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return {
      update: (next?: () => void) => {
        current = next;
      },
      destroy: () => observer.disconnect(),
    };
  }

  const name = $derived(authorName(event.pubkey, profile));
  const handle = $derived(authorHandle(event.pubkey, profile));
  const refs = $derived(parseRefs(event));

  const REF_LABELS: Record<'reply' | 'quote', string> = {
    reply: '返信先',
    quote: '引用',
  };

  /**
   * The time of day only.
   *
   * The date is dropped so the name and the timestamp always fit on one line;
   * the full date stays available as the `title` and in the `datetime`
   * attribute.
   */
  function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
</script>

<article class="event-card" class:with-avatar={showAvatar} use:whenVisible={onVisible}>
  {#if showAvatar}
    <Avatar pubkey={event.pubkey} {profile} {name} />
  {/if}
  <div class="body">
    <header>
      <span class="identity" title={event.pubkey}>
        <span class="name">{name}</span>
        {#if handle}
          <span class="handle">@{handle}</span>
        {/if}
      </span>
      <span class="meta">
        <!-- The ✓ lives here rather than beside the name on purpose: the name
             is upstream-controlled text, and an author whose display_name ends
             in "✓" could otherwise pass for a verified one. -->
        {#if status === 'validated'}
          <span class="verified" title="署名検証済み" aria-label="署名検証済み" role="img">✓</span>
        {/if}
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
        <time
          datetime={new Date(event.created_at * 1000).toISOString()}
          title={new Date(event.created_at * 1000).toLocaleString()}
        >
          {formatTime(event.created_at)}
        </time>
      </span>
    </header>
    {#if refs.length > 0}
      <ul class="refs">
        {#each refs as ref (ref.id)}
          <li class="ref">
            <span class="ref-label">{REF_LABELS[ref.kind]}</span>
            <!-- Only the reference itself: the widget never fetches the target,
                 so there is no body to preview here. -->
            <span class="ref-id" title={ref.id}>{shortPubkey(ref.id)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="content">{event.content}</p>
  </div>
</article>

<style>
  .event-card {
    display: grid;
    /* One column until an avatar is asked for, so hiding avatars closes the
       gutter instead of leaving the text indented. */
    grid-template-columns: 1fr;
    gap: var(--nt-avatar-gap, 10px);
    padding: var(--nt-card-padding, 10px 12px);
    background: var(--nt-card-bg, transparent);
    color: var(--nt-fg, #0f1419);
  }

  .with-avatar {
    grid-template-columns: auto minmax(0, 1fr);
  }

  /* Every child of a grid item defaults to min-width:auto, which lets long
     unbroken content push the card wider than the embed. */
  .body {
    min-width: 0;
  }

  header {
    display: flex;
    align-items: baseline;
    /* One line, always: the name and the handle give up width (and ellipsize)
       so the timestamp stays on the same row however narrow the embed gets. */
    flex-wrap: nowrap;
    gap: 2px 8px;
    margin-bottom: 4px;
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: 4px;
    /* The name may be long; let it shrink and ellipsize rather than shove the
       timestamp off the card. */
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
  }

  .name {
    font-weight: 700;
    color: var(--nt-name-fg, inherit);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* A flex item defaults to min-width:auto, which refuses to shrink below the
       text's own width — without this the ellipsis never appears. */
    min-width: 0;
    /* Never shrink, but never exceed the row either: flex shrinking is
       proportional, so a shrinkable name would give up a few pixels — and pick
       up an ellipsis — even when only the handle is too long. Capping the width
       instead makes the handle absorb the whole squeeze first, and still
       ellipsizes a name that is too long on its own. */
    max-width: 100%;
    flex: 0 0 auto;
  }

  .handle {
    color: var(--nt-handle-fg, var(--nt-muted, #657786));
    font-size: 0.85em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    /* The only shrinkable part of the row: the handle is the redundant half, so
       it gives up its width — down to nothing — before the name loses any. */
    flex: 0 1 auto;
  }

  .verified {
    color: var(--nt-verified, #17bf63);
    font-weight: 700;
    flex: none;
  }

  .meta {
    display: flex;
    gap: 2px 8px;
    align-items: baseline;
    /* The badges and the time are all short and must not be split up. */
    flex-wrap: nowrap;
    /* Push the metadata to the right edge whatever the name's length. */
    margin-left: auto;
    color: var(--nt-muted, #657786);
    font-size: 0.8rem;
    flex: none;
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

  .refs {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ref {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding-left: 8px;
    border-left: 3px solid var(--nt-quote-bar, #4a7dff);
    font-size: 0.8rem;
    color: var(--nt-muted, #657786);
  }

  .ref-label {
    font-weight: 700;
    flex: none;
  }

  .ref-id {
    font-family: var(--nt-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
</style>
