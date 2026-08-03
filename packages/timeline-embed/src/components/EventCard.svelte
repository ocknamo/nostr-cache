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

  const createdAt = $derived(new Date(event.created_at * 1000));

  /** Held open by a tap or a keyboard press, until the next one. */
  let pinned = $state(false);
  /** Open for as long as a mouse rests on the timestamp. */
  let hovered = $state(false);
  const dateVisible = $derived(pinned || hovered);
  /**
   * Scoped to the shadow root the widget renders into, and unique within it:
   * one card per event id.
   */
  const tooltipId = $derived(`nt-date-${event.id}`);

  /**
   * Escape closes the tooltip.
   *
   * A tooltip that appears on hover has to be dismissable without moving the
   * pointer (WCAG 2.1 §1.4.13), and the listener only exists while one is
   * open — a timeline is 50 cards by default.
   */
  $effect(() => {
    if (!dateVisible) {
      return;
    }
    const onKeydown = (keyboard: KeyboardEvent) => {
      if (keyboard.key === 'Escape') {
        pinned = false;
        hovered = false;
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  /**
   * The time of day only.
   *
   * The date is dropped so the name and the timestamp always fit on one line;
   * the full date stays available as the `title` and in the `datetime`
   * attribute.
   *
   * `hourCycle` rather than `hour12: false`, which some engines resolve to the
   * `h24` cycle — where midnight reads as `24:00:00`.
   */
  function formatTime(at: Date): string {
    return at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }
</script>

<article class="event-card" class:with-avatar={showAvatar} use:whenVisible={onVisible}>
  {#if showAvatar}
    <Avatar pubkey={event.pubkey} {profile} {name} />
  {/if}
  <div class="body">
    <!-- The tooltip hangs off this wrapper rather than off the header, which
         clips its own overflow to stay on one line. -->
    <div class="header-row">
      <header>
        <span class="identity" class:with-handle={handle} title={event.pubkey}>
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
          <!-- A button rather than bare text with a `title`: a native tooltip
               needs a hover, and a touch reader has none. This one opens on
               hover, on tap and from the keyboard. -->
          <button
            type="button"
            class="timestamp"
            aria-expanded={dateVisible}
            aria-describedby={dateVisible ? tooltipId : undefined}
            aria-label={dateVisible ? '日付を隠す' : '日付を表示'}
            onclick={() => {
              pinned = !pinned;
            }}
            onpointerenter={(pointer) => {
              // Mouse only: a tap fires this too, and opening on it would let
              // the click that follows immediately close the tooltip again.
              hovered = pointer.pointerType === 'mouse';
            }}
            onpointerleave={() => {
              hovered = false;
            }}
          >
            <time datetime={createdAt.toISOString()}>
              {formatTime(createdAt)}
            </time>
          </button>
        </span>
      </header>
      {#if dateVisible}
        <span class="date-tip" id={tooltipId} role="tooltip">{createdAt.toLocaleString()}</span>
      {/if}
    </div>
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
    gap: 8px;
    margin-bottom: 4px;
    /* Below roughly 180px of card there is not enough room even after the name
       has collapsed. Clip what is left here rather than let a one-line header
       widen the card and hand the embedding page a horizontal scrollbar. */
    overflow: hidden;
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: 4px;
    /* The name and the handle are what give up width when the row is tight,
       rather than the timestamp. */
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

  /* With a handle to its right, the cap leaves room for it: taking the whole
     row would squeeze the handle out of existence — silently, since a box of
     zero width has nowhere to draw an ellipsis. The name still keeps at least
     60% of the row, so it stays the part that survives on a narrow embed. */
  .with-handle .name {
    max-width: max(60%, 100% - 4.5em);
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
    gap: 8px;
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

  /* Reads as the plain timestamp it replaces: no button chrome, the meta row's
     own colour and size. The vertical padding buys a tappable target and is
     cancelled by the margin so the baseline does not move. */
  .timestamp {
    appearance: none;
    background: none;
    border: 0;
    padding: 4px 0;
    margin: -4px 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
    /* A tap should reveal the date, not paint the timestamp blue and leave the
       text half-selected. */
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }

  .timestamp:hover time,
  .timestamp:focus-visible time {
    text-decoration: underline dotted;
  }

  .header-row {
    position: relative;
  }

  .date-tip {
    position: absolute;
    /* Just above the timestamp it belongs to, at the same edge of the card.
       The first card would otherwise have no room above it to open into —
       see the list's top padding in Timeline.svelte. */
    bottom: calc(100% + 2px);
    right: 0;
    z-index: 1;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--nt-tip-bg, #0f1419);
    color: var(--nt-tip-fg, #fff);
    font-size: 0.75rem;
    line-height: 1.5;
    box-shadow: 0 2px 8px rgb(15 20 25 / 25%);
    /* Out of the flow, so opening it moves nothing: it floats over the card
       rather than pushing the note down. */
    max-width: 100%;
    /* The whole point is the date the header dropped, so let it wrap on a
       narrow embed rather than hang off the card. */
    white-space: normal;
    word-break: break-word;
    /* Never swallow a tap meant for the card underneath. */
    pointer-events: none;
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
