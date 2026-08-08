<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import type { EventAction, EventActionContext } from '../lib/event-actions.ts';
  import { parseRefs } from '../lib/event-refs.ts';
  import { type MaterialVariant, materialFontFamily } from '../lib/material-symbols.ts';
  import { type Profile, authorHandle, authorName, shortPubkey } from '../lib/profile.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import Avatar from './Avatar.svelte';
  import NoteContent from './NoteContent.svelte';

  interface Props {
    event: NostrEvent;
    /** Where the event was served from. Hidden when undefined. */
    origin?: EventOrigin;
    /** The relay's persisted signature-verification verdict. */
    status?: ValidationStatus;
    /** The author's kind 0 profile, once it has been fetched. */
    profile?: Profile;
    /**
     * Every profile the timeline has, keyed by pubkey. Used only to put a name
     * on a `nostr:` mention in the body; the author's own name comes from
     * `profile`.
     */
    profiles?: Map<string, Profile>;
    /** Render the author's avatar. */
    showAvatar?: boolean;
    /** Render image / video / audio attachments found in the body. */
    showMedia?: boolean;
    /**
     * Which way the date tooltip opens.
     *
     * `above` everywhere except the first card of a list, which has nothing
     * above it to open into — see the list's top padding in `Timeline.svelte`.
     */
    datePlacement?: 'above' | 'below';
    /**
     * Buttons to render under the note. Empty by default: the widget ships no
     * actions of its own — see `lib/event-actions.ts`.
     */
    actions?: EventAction[];
    /**
     * Called on a press, after the action's own `onSelect`. The widget uses it
     * to raise the `nostr-timeline:action` DOM event on the custom element.
     */
    onAction?: (action: EventAction, context: EventActionContext) => void;
    /**
     * Render action icons as Material Symbols ligatures of this variant.
     * Undefined leaves every `icon` as the literal text it is. An action's own
     * `iconType` overrides this either way.
     */
    materialIcons?: MaterialVariant;
    /**
     * Called once, when the card first enters the viewport. The timeline uses
     * this to look up the author's profile only for cards a reader can see.
     */
    onVisible?: () => void;
  }

  const {
    event,
    origin,
    status,
    profile,
    profiles,
    showAvatar = true,
    showMedia = true,
    datePlacement = 'above',
    actions = [],
    onAction,
    materialIcons,
    onVisible,
  }: Props = $props();

  /** Whether this button's `icon` is a ligature name rather than literal text. */
  function isMaterial(action: EventAction): boolean {
    return action.iconType === 'material' || (materialIcons !== undefined && action.iconType !== 'text');
  }

  /**
   * The family, inline.
   *
   * It is the one part of the icon's styling that depends on a runtime value —
   * the variant — and a scoped stylesheet cannot interpolate one. Everything
   * else (size, weight, fill, ligature setup) stays in the `.material` rule.
   */
  const materialStyle = $derived(
    materialIcons ? `font-family: '${materialFontFamily(materialIcons)}'` : undefined
  );

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

  /**
   * Whether the note is taller than the cap, and whether it is scrolled to the
   * bottom.
   *
   * Both are measured rather than assumed: a card only becomes a scroll area
   * when its note actually overflows, and until then it must not pick up a tab
   * stop (one per card, on a 50-card timeline) or the bottom fade.
   */
  let noteOverflowing = $state(false);
  let noteAtEnd = $state(false);

  /**
   * Track the note's overflow, so the box can announce itself as a scroll area
   * only while it is one.
   *
   * Watched with a `ResizeObserver` because a note grows after first paint: an
   * attached image has no height until it loads, and a profile arriving turns a
   * short npub into a name. Where the observer is missing (jsdom) the note stays
   * a plain box — the cap still clips it, it just gets no keyboard affordance,
   * which is the safe way round.
   */
  function watchOverflow(node: HTMLElement) {
    const measure = () => {
      // A sub-pixel line box rounds the two apart on a note that fits, so a
      // whole pixel is the smallest difference worth calling an overflow.
      noteOverflowing = node.scrollHeight - node.clientHeight > 1;
      noteAtEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    };

    measure();
    node.addEventListener('scroll', measure, { passive: true });

    if (typeof ResizeObserver === 'undefined') {
      return {
        destroy: () => node.removeEventListener('scroll', measure),
      };
    }
    // The box itself for a resized embed, the content for a note that grew
    // inside it — neither alone catches both.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) {
      observer.observe(child);
    }
    return {
      destroy: () => {
        observer.disconnect();
        node.removeEventListener('scroll', measure);
      },
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

  /**
   * Anything the relay has not vouched for yet, which is every card at first
   * paint: the relay validates lazily, so `validated` arrives a few seconds
   * later (or never, for an event it is about to delete as forged). The card is
   * faded rather than hidden — the same trade-off the ✓ badge already makes,
   * only now visible without hunting for the absence of a mark.
   */
  const unverified = $derived(status !== 'validated');

  function select(action: EventAction): void {
    // A snapshot, not the event itself: what the timeline holds is a Svelte
    // state proxy, and handing that out leaks the widget's own reactive state
    // to the embedder — who could mutate the card from under it, and cannot
    // `postMessage` it at all (a proxy is not structured-cloneable, which is
    // exactly how the iframe path breaks).
    // The verdict travels with it: the widget shows unverified events (faded),
    // so an embedder wiring a button that signs, reposts or pays must be able
    // to tell what the relay has actually vouched for. Nothing else on this
    // path carries it — the DOM event and the iframe's `postMessage` are all
    // the embedder gets.
    const context: EventActionContext = { event: $state.snapshot(event), status };
    // The embedder's own handler runs first, but must not be able to swallow
    // the press: without this, one throwing `onSelect` would also stop the DOM
    // event every other listener on the page is waiting for.
    try {
      action.onSelect?.(context);
    } catch (error) {
      console.error(`[nostr-timeline] action "${action.id}" threw`, error);
    }
    onAction?.(action, context);
  }
</script>

<article
  class="event-card"
  class:with-avatar={showAvatar}
  class:unverified
  class:tip-open={dateVisible}
  use:whenVisible={onVisible}
>
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
        <span
          class="date-tip"
          class:below={datePlacement === 'below'}
          id={tooltipId}
          role="tooltip">{createdAt.toLocaleString()}</span
        >
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
    <!--
      The note, and the only part of the card that scrolls.

      A single very long post used to fill the whole timeline; now the card is
      capped (--nt-card-max-height) and the overflow is scrolled here, so the
      header, the reference chips and the action row all stay put while the
      body moves under them.

      The scroll area is only announced as one — labelled, and reachable by
      keyboard — while it actually overflows: WCAG 2.1.1 asks for a scrollable
      region to be operable without a mouse, but an unconditional tab stop
      would put one on every card in the list. The rule below flags exactly
      that pattern, which is the one WCAG asks for here.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="note"
      class:overflowing={noteOverflowing}
      class:at-end={noteAtEnd}
      role={noteOverflowing ? 'region' : undefined}
      tabindex={noteOverflowing ? 0 : undefined}
      aria-label={noteOverflowing ? '投稿本文（スクロールできます）' : undefined}
      use:watchOverflow
    >
      <NoteContent content={event.content} {showMedia} {profiles} />
    </div>
  </div>
  <!--
    The embedder's buttons. Nothing is rendered unless they asked for some, so a
    plain embed keeps the card it had.

    The `title` is set only on an icon button, where the glyph stands in for the
    name; on a label-only button it would repeat the text beneath it.
  -->
  {#if actions.length > 0}
    <footer class="actions" part="actions">
      {#each actions as action (action.id)}
        <button
          type="button"
          class="action"
          class:with-label={action.icon && action.showLabel}
          part="action action-{action.id}"
          data-action={action.id}
          title={action.icon ? action.label : undefined}
          aria-label={action.label}
          disabled={action.disabled}
          onclick={() => select(action)}
        >
          {#if action.icon}
            <!-- The glyph is decorative; `aria-label` above carries the name.
                 `translate="no"` because a Material ligature name is markup,
                 not prose: a page translator would otherwise turn `favorite`
                 into a word and the icon into gibberish. -->
            <span
              class="action-icon"
              class:material={isMaterial(action)}
              style={isMaterial(action) ? materialStyle : undefined}
              translate="no"
              aria-hidden="true">{action.icon}</span
            >
          {/if}
          {#if !action.icon || action.showLabel}
            <span class="action-label">{action.label}</span>
          {/if}
        </button>
      {/each}
    </footer>
  {/if}
</article>

<style>
  .event-card {
    display: grid;
    /* One column until an avatar is asked for, so hiding avatars closes the
       gutter instead of leaving the text indented. */
    grid-template-columns: 1fr;
    /*
     * One long post must not take the whole timeline: past this height the
     * note scrolls inside the card instead of pushing every other post off
     * the screen. Set --nt-card-max-height to `none` to go back to cards that
     * are as tall as their content.
     *
     * The row holding the note is minmax(0, 1fr) so it is the part that gives
     * up height when the cap bites — an `auto` row refuses to shrink below its
     * content, which leaves the note at full height and the card overflowing
     * past the cap (measured, not guessed). With an indefinite height there is
     * no free space to distribute, so a card that fits stays exactly as tall
     * as its content.
     *
     * Only that one row is declared. The action row is left implicit (`auto`),
     * so it keeps its own height — it is the last thing a reader should have to
     * scroll to reach — and a card without actions gets no second track, and so
     * no row gap under a note that has nothing below it.
     *
     * border-box so the cap means the height of the whole post, padding
     * included, rather than 420px plus whatever --nt-card-padding is.
     */
    box-sizing: border-box;
    max-height: var(--nt-card-max-height, 420px);
    grid-template-rows: minmax(0, 1fr);
    gap: var(--nt-avatar-gap, 10px);
    padding: var(--nt-card-padding, 10px 12px);
    background: var(--nt-card-bg, transparent);
    color: var(--nt-fg, #0f1419);
  }

  .with-avatar {
    grid-template-columns: auto minmax(0, 1fr);
  }

  /* Everything the relay has not vouched for is faded — which is every card for
     the first few seconds, since validation runs lazily in the background. Set
     --nt-unverified-opacity to 1 to switch the distinction off; the ✓ badge
     still marks the validated ones. */
  .unverified {
    opacity: var(--nt-unverified-opacity, 0.6);
  }

  /* A faded card is its own stacking context, which traps the date tooltip's
     z-index inside it: the next card, painting later as a sibling, would come
     out on top of the tooltip and leave it unreadable. Lifting the whole card
     while its tooltip is open puts it back above what follows — and only then,
     so nothing else about the list's layering changes. */
  .tip-open {
    position: relative;
    z-index: 2;
  }

  /* Validation lands in batches, so without this a whole screen of cards snaps
     to full opacity at once. Not a movement, but honour the setting anyway. */
  @media (prefers-reduced-motion: no-preference) {
    .event-card {
      transition: opacity 200ms ease-out;
    }
  }

  /* Every child of a grid item defaults to min-width:auto, which lets long
     unbroken content push the card wider than the embed. */
  .body {
    min-width: 0;
    /* Column flex so the header and the reference chips keep their height and
       the note absorbs whatever the card's cap leaves. min-height for the same
       reason as min-width: without it this item refuses to shrink below its
       content and the cap above has nothing to act on. */
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .note {
    /* How much of the bottom edge the fade below covers. Unprefixed because it
       is internal to this card, not part of the --nt-* API. */
    --note-fade: 28px;
    /* The one scrolling box in the card. It takes the space the header and the
       chips leave, and scrolls once its content no longer fits. */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* Horizontal overflow is already impossible (everything inside wraps or
       breaks); saying so keeps a stray wide child from adding a second bar. */
    overflow-x: hidden;
    /* Reaching the end of a note should carry on scrolling the timeline, the
       way a nested scroll area in a Nostr client does — `contain` here would
       stop the wheel dead on every long post. */
    overscroll-behavior-y: auto;
    /* Tabbing to a link near the bottom scrolls it into view; without this the
       browser would stop with it half under the fade. */
    scroll-padding-bottom: var(--note-fade);
  }

  /*
   * A hint that there is more note below.
   *
   * A mask rather than an overlaid gradient: it is painted in the box's own
   * coordinates, so it stays at the bottom edge while the content scrolls
   * under it, and it needs no extra element to hang off. It lifts at the end
   * of the note, where fading the last line would just look like a rendering
   * bug. Overlay scrollbars (macOS, touch) are invisible until a scroll
   * starts, so without this a capped note gives no sign it was cut.
   */
  .note.overflowing:not(.at-end) {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - var(--note-fade)), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - var(--note-fade)), transparent);
  }

  /* The box only becomes focusable while it overflows, so this only ever marks
     a real scroll area. */
  .note:focus-visible {
    outline: 2px solid var(--nt-link-fg, #1d9bf0);
    outline-offset: 2px;
    border-radius: 4px;
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

  /* The first card of a list has nothing above it to open into, so its tooltip
     flips under the header instead. It floats over the note (out of the flow,
     click-through) rather than pushing it down. */
  .date-tip.below {
    bottom: auto;
    top: calc(100% + 2px);
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

  /* Spans the avatar gutter too, so the row runs the full width of the card the
     way a Nostr client's does — and does not shift when avatars are off. */
  .actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    /* Right-aligned by default. --nt-actions-justify takes any `justify-content`
       value, so `space-between` spreads them across the card, `flex-start` puts
       them under the note, `center` centres them. */
    justify-content: var(--nt-actions-justify, flex-end);
    gap: var(--nt-action-gap, 8px);
    margin-top: 6px;
    /* One row, always. The buttons shrink and their labels ellipsize, and what
       still will not fit is clipped here — the header above does the same, for
       the same reason: a row that grew past the card would hand the embedding
       page a horizontal scrollbar. */
    flex-wrap: nowrap;
    min-width: 0;
    overflow: hidden;
  }

  .action {
    appearance: none;
    background: none;
    border: 0;
    border-radius: 999px;
    /* Roughly the 44px-square target the pointer guidelines ask for once the
       glyph's own line box is added. */
    padding: var(--nt-action-padding, 6px 10px);
    font: inherit;
    font-size: var(--nt-action-size, 1rem);
    line-height: 1;
    color: var(--nt-action-fg, var(--nt-muted, #657786));
    cursor: pointer;
    /* A flex item refuses to shrink below its content's width without this, so
       a long label would push the row wide rather than ellipsize. */
    min-width: 0;
    flex: 0 1 auto;
    -webkit-tap-highlight-color: transparent;
  }

  .action:hover:not(:disabled),
  .action:focus-visible {
    color: var(--nt-action-hover-fg, var(--nt-link-fg, #1d9bf0));
    background: var(--nt-action-hover-bg, rgb(29 155 240 / 10%));
  }

  .action:disabled {
    cursor: default;
    opacity: 0.5;
  }

  /* `block`, not the span's default `inline`: `overflow` and `text-overflow`
     do nothing on a non-replaced inline box, so an inline label would never
     ellipsize however narrow the embed got. */
  .action-label {
    display: block;
    font-size: 0.85em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action-icon {
    display: block;
    white-space: nowrap;
    overflow: hidden;
  }

  /* A button showing both needs them side by side, and the label is the part
     that gives up width. */
  .with-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /*
   * Material Symbols: the `icon` is a ligature name (`favorite`), and this rule
   * is what turns it into the icon. The family is set inline, from the chosen
   * variant; the fallback here covers an action that asked for `material` on
   * its own, without the widget-level switch.
   *
   * The font itself must be registered on the document — a shadow root's
   * `@font-face` is ignored — which `material-icons` does by injecting Google's
   * stylesheet. Until it loads, the ligature name shows as the word it is.
   */
  .material {
    font-family: var(--nt-material-font, 'Material Symbols Outlined');
    font-weight: normal;
    font-style: normal;
    font-size: var(--nt-action-icon-size, 20px);
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    word-wrap: normal;
    direction: ltr;
    /* The ligature is the whole mechanism, so make sure nothing has turned
       ligatures off further up. */
    font-feature-settings: 'liga';
    -webkit-font-smoothing: antialiased;
    /* Filled/weight are the two axes worth exposing; the rest stay at Google's
       defaults for the 20px optical size this renders at. */
    font-variation-settings:
      'FILL' var(--nt-material-fill, 0),
      'wght' var(--nt-material-weight, 400),
      'GRAD' 0,
      'opsz' 20;
  }
</style>
