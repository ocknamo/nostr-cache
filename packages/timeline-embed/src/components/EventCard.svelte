<script lang="ts">
  import type { NostrEvent } from '@nostr-cache/shared';
  import type { EventOrigin } from '../lib/cache-metrics.ts';
  import { parseContent } from '../lib/content-parts.ts';
  import { eventPreview } from '../lib/content-preview.ts';
  import type { AuthorAction, EventAction, EventActionContext } from '../lib/event-actions.ts';
  import { parseRefs } from '../lib/event-refs.ts';
  import { type MaterialVariant, materialFontFamily } from '../lib/material-symbols.ts';
  import {
    type EmbedTarget,
    type EmbeddedEvent,
    embedKeys,
    eventIdTarget,
    noteSegments,
    segmentKey,
    segmentMedia,
    selectEmbeds,
  } from '../lib/note-embeds.ts';
  import { type Profile, authorHandle, authorName, shortPubkey } from '../lib/profile.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import { whenVisible } from '../lib/when-visible.ts';
  import Avatar from './Avatar.svelte';
  import EmbeddedNote from './EmbeddedNote.svelte';
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
     * Used only by the nested cards — this card's own verdict is `status`.
     */
    validationStatuses?: Map<string, ValidationStatus>;
    /** Events quoted by a `nostr:` reference in some body, keyed by `embedKey`. */
    embeds?: Map<string, EmbeddedEvent>;
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
     * Render the events a `nostr:` reference in the body points at, as nested
     * cards (NIP-27). With this off — or with neither an `onEmbedRequest` to
     * fetch through nor `embeds` already resolved — a reference stays the
     * abbreviated chip it has always been.
     */
    showEmbeds?: boolean;
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
     * Makes the author's avatar and display name pressable, reporting the press
     * under this id. Undefined leaves both the plain image and text they are —
     * see `lib/event-actions.ts`.
     */
    authorAction?: AuthorAction;
    /**
     * Called on a press, after the action's own `onSelect`. The widget uses it
     * to raise the `nostr-timeline:action` DOM event on the custom element.
     */
    onAction?: (action: EventAction | AuthorAction, context: EventActionContext) => void;
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
    onEmbedRequest?: (target: EmbedTarget) => void;
    /**
     * Called with the parent's id when the 「返信先」 chip is pressed.
     *
     * Without it the chip stays the plain text it has always been: a card in a
     * timeline has nowhere to navigate to, and sending a reader out to some
     * stranger's client is not what this widget does. Only the reply chip gets
     * this — a quote is usually already open as a nested card, and pressing one
     * would replace the post a page deliberately embedded.
     */
    onNavigate?: (id: string) => void;
    /**
     * Off inside a thread, where the parent is the card this one is nested
     * under: repeating it as an abbreviated id says nothing the layout has not
     * already said, on every card. Quote chips are unaffected — the note a
     * reply quotes is not on screen.
     */
    showReplyRef?: boolean;
  }

  const {
    event,
    origin,
    status,
    profile,
    profiles,
    validationStatuses,
    embeds,
    showAvatar = true,
    showMedia = true,
    showEmbeds = true,
    datePlacement = 'above',
    actions = [],
    authorAction,
    onAction,
    materialIcons,
    onVisible,
    onEmbedRequest,
    onNavigate,
    showReplyRef = true,
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

  const name = $derived(authorName(event.pubkey, profile));
  const handle = $derived(authorHandle(event.pubkey, profile));

  const parts = $derived(parseContent(event.content));
  /**
   * Without either a way to fetch (`onEmbedRequest`) or events already resolved
   * for it (`embeds`), lifting a reference out of the text would leave nothing
   * to put in its place — so a consumer that wires neither gets the body it
   * always got, rather than a placeholder that never resolves.
   */
  const resolvable = $derived(Boolean(onEmbedRequest) || (embeds?.size ?? 0) > 0);
  const embedded = $derived(showEmbeds && resolvable ? selectEmbeds(parts, 0) : []);
  const embeddedKeys = $derived(embedKeys(embedded));
  /** Text and card segments, in the order the author actually wrote them. */
  const segments = $derived(noteSegments(parts, embeddedKeys));
  /**
   * Attachments per `text` segment, deduped by URL across the whole note —
   * not just within whichever segment a repeated URL happens to fall in.
   */
  const segmentMediaLists = $derived(showMedia ? segmentMedia(segments) : []);

  /**
   * A quote is normally written twice — as a `nostr:` code in the body (NIP-27)
   * and as a `q` tag (NIP-18) — so a quote already showing as a nested card
   * would otherwise also show as a chip pointing at the same event. The reply
   * chip stays whatever the body does: a reply's parent is context the author
   * did not choose to quote, and "返信先" says something the quote card does not.
   */
  const refs = $derived(
    parseRefs(event).filter((ref) =>
      ref.kind === 'quote' ? !embeddedKeys.has(ref.id) : showReplyRef
    )
  );

  const REF_LABELS: Record<'reply' | 'quote', string> = {
    reply: '返信先',
    quote: '引用',
  };

  /**
   * The parent, once something has resolved it — the chip's own lookup, or the
   * body quoting the same event, which lands under the same key.
   *
   * Gated on `showEmbeds` like the body's quote cards are, and for the stronger
   * of the two reasons that switch exists: it is documented as stopping the
   * card from costing extra requests at all, and a rendered preview pulls the
   * parent author's avatar from a host the embedding page never named. Reading
   * an `embeds` entry that is already there would be free, but drawing it is
   * not.
   */
  const replyRef = $derived(refs.find((ref) => ref.kind === 'reply'));
  const replyResolved = $derived(showEmbeds && replyRef ? embeds?.get(replyRef.id) : undefined);
  const replyEvent = $derived(replyResolved?.status === 'ready' ? replyResolved.event : undefined);
  const replyProfile = $derived(replyEvent && profiles?.get(replyEvent.pubkey));
  const replyName = $derived(replyEvent ? authorName(replyEvent.pubkey, replyProfile) : '');
  /** Empty until the parent resolves, which is what keeps the chip as it was. */
  const replyPreview = $derived(replyEvent ? eventPreview(replyEvent, { profiles }) : '');

  function requestReply(): void {
    if (!replyRef || !showEmbeds) {
      return;
    }
    onEmbedRequest?.(eventIdTarget(replyRef.id));
  }

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

  /**
   * @param pubkey Who was pressed, for a press on a person rather than on a
   *   button. Left off by the action bar.
   */
  function select(action: EventAction | AuthorAction, pubkey?: string): void {
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
    const context: EventActionContext = {
      event: $state.snapshot(event),
      status,
      ...(pubkey ? { pubkey } : {}),
    };
    // Only a declared button can carry one: the author press is declared by two
    // attributes, and an attribute cannot hold a function.
    const handler = 'onSelect' in action ? action.onSelect : undefined;
    // The embedder's own handler runs first, but must not be able to swallow
    // the press: without this, one throwing `onSelect` would also stop the DOM
    // event every other listener on the page is waiting for.
    try {
      handler?.(context);
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
    {#if authorAction}
      <!-- Out of the tab order and out of the accessibility tree: the identity
           below is the same press with the same destination, and a screen
           reader announcing it twice per card — or 50 extra tab stops in a
           timeline — is what a second target would cost.
           `aria-hidden` on a button holds only while nothing can focus it, and
           `tabindex="-1"` covers the keyboard alone: a pointer press focuses a
           button by itself, which would drop focus onto an element no longer
           in the accessibility tree. `preventDefault` on the press is what
           withholds that — the click still fires. -->
      <button
        type="button"
        class="author-avatar"
        part="author-avatar"
        tabindex="-1"
        aria-hidden="true"
        onpointerdown={(pointer) => pointer.preventDefault()}
        onclick={() => select(authorAction, event.pubkey)}
      >
        <Avatar pubkey={event.pubkey} {profile} {name} />
      </button>
    {:else}
      <Avatar pubkey={event.pubkey} {profile} {name} />
    {/if}
  {/if}
  <div class="body">
    <!-- The tooltip hangs off this wrapper rather than off the header, which
         clips its own overflow to stay on one line. -->
    <div class="header-row">
      <header>
        <!-- The two spellings share their contents, so the name and the handle
             keep one set of rules for how they give up width to the row. -->
        {#snippet identity()}
          <span class="name">{name}</span>
          {#if handle}
            <span class="handle">@{handle}</span>
          {/if}
        {/snippet}
        {#if authorAction}
          <!-- The label first, then whose it is: the same order the 「返信先」
               chip announces itself in, and the part a reader moving through a
               list of cards needs before the name. The handle is repeated into
               the label because an `aria-label` replaces the text inside the
               button — without it, turning the press on would take the @handle
               away from a screen reader and leave it on screen for everyone
               else. -->
          <button
            type="button"
            class="identity author"
            class:with-handle={handle}
            part="author"
            title={event.pubkey}
            aria-label={`${authorAction.label}: ${name}${handle ? ` @${handle}` : ''}`}
            onclick={() => select(authorAction, event.pubkey)}
          >
            {@render identity()}
          </button>
        {:else}
          <span class="identity" class:with-handle={handle} title={event.pubkey}>
            {@render identity()}
          </span>
        {/if}
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
          <!-- The preview is fetched from here rather than with the card's own
               profile lookup: a reader who never scrolls to a reply should not
               pay for its parent. -->
          <li class="ref" part="ref" use:whenVisible={ref.kind === 'reply' ? requestReply : undefined}>
            <span class="ref-label">{REF_LABELS[ref.kind]}</span>
            {#if ref.kind === 'reply' && replyEvent && replyPreview}
              {#if onNavigate}
                <!-- A real button, so Enter, Space, the tab order and the role a
                     screen reader announces all come for free. The avatar is
                     inside it: the whole chip is one press target, and the
                     `aria-label` then covers the image with it. -->
                <button
                  type="button"
                  class="ref-nav"
                  part="ref-nav"
                  title="{replyName}: {replyPreview}"
                  aria-label="返信先の投稿を開く: {replyName}「{replyPreview}」"
                  onclick={() => onNavigate(ref.id)}
                >
                  {#if showAvatar}
                    <Avatar pubkey={replyEvent.pubkey} profile={replyProfile} name="" />
                  {/if}
                  <span class="ref-text">{replyPreview}</span>
                </button>
              {:else}
                {#if showAvatar}
                  <!-- name="" on purpose: the generated fallback block is
                       aria-hidden, so an `alt` here would announce the author
                       only for the ones who published a picture. The span
                       below says it for all of them. -->
                  <Avatar pubkey={replyEvent.pubkey} profile={replyProfile} name="" />
                {/if}
                <span class="ref-author">{replyName}</span>
                <span class="ref-text" title="{replyName}: {replyPreview}">{replyPreview}</span>
              {/if}
            {:else if onNavigate && ref.kind === 'reply'}
              <button
                type="button"
                class="ref-id ref-nav"
                part="ref-nav"
                title={ref.id}
                aria-label="返信先の投稿を開く"
                onclick={() => onNavigate(ref.id)}>{shortPubkey(ref.id)}</button
              >
            {:else}
              <span class="ref-id" title={ref.id}>{shortPubkey(ref.id)}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <!--
      No `tabindex` of its own: a browser puts a scroll container with no
      focusable children into the tab order by itself, and only while it
      actually scrolls — which is what WCAG 2.1.1 asks for here, and the
      distinction a hand-written attribute would have to measure to make.
      (Checked in Chromium.) Where a browser lacks that, a capped note stays
      readable by mouse and touch.
    -->
    <div class="note" part="note">
      <!-- Inside the scrolling box on purpose: a chain of quotes then grows the
           scroll rather than the card, keeping the height cap. Cards render
           where the author's own `nostr:` reference sat in the text, rather
           than all collapsed to the bottom. -->
      {#each segments as segment, index (segmentKey(segment, index))}
        {#if segment.kind === 'text'}
          <NoteContent
            parts={segment.parts}
            embedded={embeddedKeys}
            {showMedia}
            {profiles}
            media={segmentMediaLists[index]}
          />
        {:else}
          <div class="embed">
            <EmbeddedNote
              entity={segment.part}
              depth={1}
              {embeds}
              {profiles}
              {validationStatuses}
              {showAvatar}
              {showMedia}
              ancestorUnverified={unverified}
              {onEmbedRequest}
            />
          </div>
        {/if}
      {/each}
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
     * Past this height the note scrolls inside the card instead of pushing
     * every other post off the screen. `none` restores content-sized cards.
     *
     * The note's row is minmax(0, 1fr) so it is the part that gives up height:
     * an `auto` row refuses to shrink below its content, leaving the card
     * overflowing past the cap (measured, not guessed). The action row is left
     * implicit, which keeps its height and — on a card without actions — keeps
     * a second track from existing at all.
     *
     * border-box so the cap is the height of the whole post, padding included.
     */
    box-sizing: border-box;
    max-height: var(--nt-card-max-height, 420px);
    grid-template-rows: minmax(0, 1fr);
    /* Column only: the gap belongs between the avatar and the text, and a
       shorthand `gap` would space the action row off the note by the same
       amount on top of the row's own margin — which is what made the buttons
       sit in a band of empty card. The action row owns that spacing instead. */
    column-gap: var(--nt-avatar-gap, 10px);
    row-gap: 0;
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
    /* min-height for the same reason as min-width: without it this item
       refuses to shrink below its content, and the cap has nothing to act on. */
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* The one scrolling box in the card: it takes the space the header and the
     chips leave, and scrolls once its content no longer fits. */
  .note {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* Everything inside wraps or breaks, so this only stops a stray wide child
       from adding a second bar. */
    overflow-x: hidden;
    /* The default, spelled out because `contain` is tempting and would stop a
       wheel here for good. Note that `auto` buys less than it sounds like: a
       browser latches a gesture to the box it started over, so a flick inside
       a long note never carries on into the timeline. */
    overscroll-behavior-y: auto;
    /* A fat scrollbar (Windows, most Linux desktops) would make an overflowing
       note narrower than the card beside it, in a colour the embed never
       chose. */
    scrollbar-width: thin;
    scrollbar-color: var(--nt-scrollbar, var(--nt-muted, #657786)) transparent;
  }

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

  /*
   * Reads as the identity it replaces: no button chrome, the header's own
   * colour and metrics. It keeps `.identity`'s flex box, so the name and the
   * handle give up width exactly as they do without the press.
   *
   * No height floor, unlike `.action` (which spells out WCAG 2.2 §2.5.8): this
   * target is a run of text on a line it shares with the timestamp, so its
   * height is the line's — the "inline" exception §2.5.8 makes for exactly
   * that. Padding it out to 24px would push the note down on every card, and
   * `header` clips its overflow, so the extra height could not hang outside
   * either. The avatar beside it is a 40px target for the same press.
   */
  .identity.author {
    appearance: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    /* A button centres its contents; this is the start of a text row. */
    text-align: start;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* On the name only, so the underline stops where the name does rather than
     running under the handle beside it. Solid, unlike the 「返信先」 chip's
     dotted rule: that one moves within the widget, this one hands the press to
     the embedding page, which usually navigates. */
  .identity.author:hover .name,
  .identity.author:focus-visible .name {
    text-decoration: underline;
  }

  /*
   * Drawn inside the box (a negative offset), not around it: `header` clips its
   * own overflow to stay on one line, so a ring outside the button is clipped
   * away on every edge that touches the header — which here is all four. The
   * timestamp beside it settles for an underline for the same reason.
   */
  .identity.author:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: -2px;
    border-radius: 4px;
  }

  /*
   * The avatar's own box, nothing more.
   *
   * `align-self` because this is a grid item: the column is sized from the
   * image, but a button has no height of its own, so the default `stretch`
   * would take the full height of the card — a press target running the length
   * of the gutter, with the image floating in the middle of it (a button
   * centres its content). The `<img>` this replaces has a fixed height and so
   * was never stretched.
   */
  .author-avatar {
    display: block;
    align-self: start;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    /* No line box of its own: without this the button is a few pixels taller
       than the image, from the strut its (empty) text would sit on. */
    line-height: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
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

  /*
   * A block box, not a flex item: the margins below collapse against the
   * text's own (`.content { margin: 0 }`, `.media { margin-top: 8px }`) and
   * against a neighbouring `.embed`'s, so a run of adjacent quotes ends up
   * `--nt-embed-gap` apart — one collapsed margin, the same as the old
   * flex `gap` produced for the list of cards below the text.
   */
  .embed {
    margin: var(--nt-embed-gap, 8px) 0;
  }

  .embed:first-child {
    margin-top: 0;
  }

  .embed:last-child {
    margin-bottom: 0;
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
    /* Not `baseline`: an avatar has none of its own, so it would hang below the
       row it sits in. */
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding-left: 8px;
    border-left: 3px solid var(--nt-quote-bar, #4a7dff);
    font-size: 0.8rem;
    color: var(--nt-muted, #657786);
    /* Avatar.svelte reads these, so nothing about it has to know it is in a
       chip — the same handoff `.quote-header` makes in EmbeddedNote. */
    --nt-avatar-size: var(--nt-ref-avatar-size, 16px);
    --nt-avatar-radius: var(--nt-ref-avatar-radius, 999px);
  }

  .ref-label {
    font-weight: 700;
    flex: none;
  }

  /* The icon keeps its width in a narrow card; the body gives up its own. */
  .ref :global(.avatar) {
    flex: none;
  }

  /* Only what is still an id. A body set in the monospace face reads as code. */
  .ref-id {
    font-family: var(--nt-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The parent's body, always on one line: the chip is context for the note
     under it, and a wrapping one would push the note itself down the card.
     `block` because `text-overflow` does nothing to an inline box. */
  .ref-text {
    display: block;
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The parent's author, for assistive tech only. The avatar beside it is
     decorative (see `name=""` above), so without this the row would say what
     was replied to but never to whom. */
  .ref-author {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .ref-nav {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font-size: inherit;
    /* A button centres its contents; this row is text. */
    text-align: start;
    cursor: pointer;
  }

  /* Back to a block box while the chip is still an id: `text-overflow` is
     ignored on a flex container, and `.ref-id` above is what elides. */
  .ref-nav.ref-id {
    display: block;
  }

  /* Dotted rather than solid: this navigates inside the widget, and drawing it
     as a web link promises a page the reader is not going to get. It goes on
     the text rather than the button so it does not run under the avatar. */
  .ref-nav.ref-id,
  .ref-nav .ref-text {
    text-decoration: underline dotted;
  }

  .ref-nav:hover {
    color: var(--nt-fg, #0f1419);
  }

  .ref-nav:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: 2px;
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
    /* The whole distance between the note and the buttons: the card's grid adds
       no row gap of its own. */
    margin-top: var(--nt-actions-margin-top, 6px);
    /*
     * The height floor on `.action` makes the button taller than the glyph
     * inside it — 4px above and below at the defaults (24px floor, 16px icon).
     * Below the row that overshoot lands on top of the card's own bottom
     * padding, so the gap under the icons read as ~14px against the ~10px above
     * the header: the row looked like it was sitting in a band of empty card.
     * Pulling the row's box back by the same 4px puts the two ends of the card
     * in balance, and takes nothing off the press target — the button keeps its
     * height, only the space the row claims below itself shrinks.
     *
     * Unlike `.timestamp` above, which cancels its own padding symmetrically
     * and moves nothing, this one pulls a single edge: the buttons end up
     * 4px inside the card's bottom padding rather than above it. Two things
     * follow, both settable away with --nt-actions-margin-bottom: 0.
     *   - The bottom of --nt-card-padding must stay above 4px. At exactly 4px
     *     the buttons touch the separator; below it they cross the line.
     *   - The 4px is the default floor's overshoot, not a derived value. Raise
     *     --nt-action-min-height (or give --nt-action-padding vertical values)
     *     and the balance wants (icon − button) / 2 instead.
     */
    margin-bottom: var(--nt-actions-margin-bottom, -4px);
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
    /* Horizontal only: vertical padding here is height every post pays for on
       top of the glyph's own box, and it read as a band of empty card rather
       than as a button. The height floor below keeps the press target. */
    padding: var(--nt-action-padding, 0 10px);
    /*
     * The press target's height, now that no padding sets it. Every
     * configuration's content is shorter than this on its own — a 16px icon,
     * a 13.6px label — so without the floor the button is what the glyph
     * happens to measure, which is under the 24x24 WCAG 2.2 §2.5.8 asks for.
     * With it, and the horizontal padding above, the defaults measure 36x24
     * for an icon and 47x24 for a label (both checked in Chromium).
     *
     * It costs the card 6px against the 24px the padding and the grid's row
     * gap used to cost it — and the row's negative bottom margin gives 4px of
     * that back, so the row is much tighter than it was.
     */
    min-height: var(--nt-action-min-height, 24px);
    /* The floor makes the button taller than its content, and a `button` is
       not a flex container by default — without this the glyph sits at the top
       of the box rather than in the middle of it. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
    /* The button is a flex container now, and a flex item defaults to
       min-width:auto — which refuses to shrink below the text and leaves the
       ellipsis below unreachable however narrow the embed gets. */
    min-width: 0;
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
     that gives up width. The flex box itself is on `.action`, for the height
     floor; this is only the space between the two. */
  .with-label {
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
    font-size: var(--nt-action-icon-size, 16px);
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
       defaults. `opsz` stays at 20 — the smallest optical size the font ships,
       and so the nearest one to the 16px this renders at. */
    font-variation-settings:
      'FILL' var(--nt-material-fill, 0),
      'wght' var(--nt-material-weight, 400),
      'GRAD' 0,
      'opsz' 20;
  }
</style>
