<script lang="ts">
  /**
   * One event quoted by a `nostr:` reference, rendered inside the note that
   * quotes it (NIP-27's "preview" rendering of a NIP-21 URI).
   *
   * The layout is deliberately *not* the timeline card's. A card puts the avatar
   * in its own grid column, so the body is indented past it for the card's whole
   * height — and a quote inside a quote inside a quote would lose that
   * indentation again at every level, until the innermost note is a column of
   * single words. Here the avatar sits in the header row only, and the body
   * starts at the frame's left edge: nesting then costs the frame's padding and
   * nothing else.
   *
   * Recursion is by self-import, and it terminates in `selectEmbeds`, which
   * returns nothing at `MAX_EMBED_DEPTH`.
   */

  import { type EntityPart, embedKey, parseContent } from '../lib/content-parts.ts';
  import type { AuthorAction, EventActionContext, NoteAction } from '../lib/event-actions.ts';
  import {
    type EmbedTarget,
    type EmbeddedEvent,
    embedKeys,
    embedTarget,
    noteSegments,
    segmentKey,
    segmentMedia,
    selectEmbeds,
  } from '../lib/note-embeds.ts';
  import { type Profile, authorHandle, authorName } from '../lib/profile.ts';
  import type { ValidationStatus } from '../lib/validation-status.ts';
  import { whenVisible } from '../lib/when-visible.ts';
  import Avatar from './Avatar.svelte';
  import Self from './EmbeddedNote.svelte';
  import NoteContent from './NoteContent.svelte';

  interface Props {
    /** The reference this card stands for, as it was written in the body. */
    entity: EntityPart;
    /** 1 for a quote on a timeline card, 2 for a quote inside that, and so on. */
    depth: number;
    /** Every quoted event resolved so far, keyed by `embedKey`. */
    embeds?: Map<string, EmbeddedEvent>;
    profiles?: Map<string, Profile>;
    /** The relay's verification verdicts, keyed by event id. */
    validationStatuses?: Map<string, ValidationStatus>;
    showAvatar?: boolean;
    showMedia?: boolean;
    /**
     * `opacity` multiplies down the tree, so a five-deep chain of unverified
     * quotes would come out at 0.6^5 — under 8%, which is invisible rather than
     * faded. The outermost unverified box owns the fade and everything inside
     * it inherits the result.
     */
    ancestorUnverified?: boolean;
    /**
     * Called when this card first appears on screen, with the lookup that would
     * resolve it. Without it — and without an `embeds` entry already — nothing
     * can resolve, so the reference is left as the chip it was.
     */
    onEmbedRequest?: (target: EmbedTarget) => void;
    /**
     * Makes this card a press target, under this id. Undefined leaves it the
     * plain frame it has always been — the widget does not know where the
     * embedding page's post screen is.
     */
    noteAction?: NoteAction;
    /**
     * Makes the header and any `nostr:` mention in the body pressable, under
     * this id — the other half of `noteAction`: the frame opens the post, the
     * header opens whoever wrote it.
     */
    authorAction?: AuthorAction;
    /** Called on either press; `context.event` is this quoted event either way. */
    onAction?: (action: NoteAction | AuthorAction, context: EventActionContext) => void;
  }

  const {
    entity,
    depth,
    embeds,
    profiles,
    validationStatuses,
    showAvatar = true,
    showMedia = true,
    ancestorUnverified = false,
    onEmbedRequest,
    noteAction,
    authorAction,
    onAction,
  }: Props = $props();

  const target = $derived(embedTarget(entity.entity));
  const key = $derived(embedKey(entity.entity));
  // Not named `state`: that would turn the `$state(…)` rune below into a store
  // subscription to it.
  const resolved = $derived(key === undefined ? undefined : embeds?.get(key));
  const event = $derived(resolved?.status === 'ready' ? resolved.event : undefined);

  const profile = $derived(event && profiles?.get(event.pubkey));
  const name = $derived(event ? authorName(event.pubkey, profile) : '');
  const handle = $derived(event ? authorHandle(event.pubkey, profile) : undefined);
  const createdAt = $derived(event && new Date(event.created_at * 1000));

  /** Same fade as a timeline card: anything the relay has not vouched for yet. */
  const unverified = $derived(
    event !== undefined && validationStatuses?.get(event.id) !== 'validated'
  );
  const fade = $derived(unverified && !ancestorUnverified);

  const parts = $derived(event ? parseContent(event.content) : []);
  /** See `resolvable` in `EventCard.svelte`. */
  const resolvable = $derived(Boolean(onEmbedRequest) || (embeds?.size ?? 0) > 0);
  const nested = $derived(resolvable ? selectEmbeds(parts, depth) : []);
  const nestedKeys = $derived(embedKeys(nested));
  /** Text and card segments, in the order the quoted author wrote them. */
  const segments = $derived(noteSegments(parts, nestedKeys));
  /** See `segmentMediaLists` in `EventCard.svelte`. */
  const segmentMediaLists = $derived(showMedia ? segmentMedia(segments) : []);

  let requested = $state(false);
  /**
   * Whether a lookup is outstanding, and so worth a placeholder. Deliberately
   * not "we have no event yet": with no `onEmbedRequest` nobody is going to
   * fetch one, and a placeholder would sit there for the life of the page.
   */
  const pending = $derived(
    target !== undefined &&
      (resolved?.status === 'loading' || (resolved === undefined && requested))
  );

  /**
   * `hourCycle` rather than `hour12: false`, which some engines resolve to the
   * `h24` cycle — where midnight reads as `24:00:00`.
   */
  function formatTime(at: Date): string {
    return at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  function request(): void {
    if (!target || !onEmbedRequest) {
      return;
    }
    requested = true;
    onEmbedRequest(target);
  }

  /** @param pubkey Who was pressed, for a press on a person rather than the frame. */
  function select(action: NoteAction | AuthorAction, pubkey?: string): void {
    if (!event) {
      return;
    }
    // A snapshot for the same reason the card's own press takes one: what is
    // handed out must not be the widget's reactive proxy — see `select` in
    // `EventCard.svelte`.
    onAction?.(action, {
      event: $state.snapshot(event),
      status: validationStatuses?.get(event.id),
      ...(pubkey ? { pubkey } : {}),
    });
  }
</script>

{#if event && createdAt}
  <article
    class="quote"
    class:unverified={fade}
    class:pressable={Boolean(noteAction)}
    part="quote"
    use:whenVisible={request}
  >
    {#if noteAction}
      <!-- The whole frame, not a button of its own: a quoted post reads as one
           thing. First, so a keyboard reader is offered the card before its
           contents — it covers them either way, since a positioned element
           paints over text. The author is in the accessible name because one
           body may hold several quotes. -->
      <button
        type="button"
        class="open"
        part="quote-open"
        aria-label={`${noteAction.label}: ${name}`}
        onclick={() => select(noteAction)}
      ></button>
    {/if}
    <header class="quote-header">
      {#if showAvatar}
        {#if authorAction}
          <!-- Out of the tab order and the accessibility tree, as the card's own
               avatar is: the name beside it is the same press. -->
          <button
            type="button"
            class="quote-avatar"
            part="quote-author-avatar"
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
      {#snippet identity()}
        <span class="name">{name}</span>
        {#if handle}
          <span class="handle">@{handle}</span>
        {/if}
      {/snippet}
      {#if authorAction}
        <button
          type="button"
          class="identity quote-author"
          part="quote-author"
          title={event.pubkey}
          aria-label={`${authorAction.label}: ${name}${handle ? ` @${handle}` : ''}`}
          onclick={() => select(authorAction, event.pubkey)}
        >
          {@render identity()}
        </button>
      {:else}
        <span class="identity" title={event.pubkey}>
          {@render identity()}
        </span>
      {/if}
      <!-- Not the tooltip button the timeline card carries: a quote can be five
           deep, and five nested popovers inside one scrolling note is more
           chrome than the date is worth. The full date stays in the `title` —
           out of reach of the pointer while `noteAction` covers the frame,
           which is the trade the embedder makes by asking for the press. -->
      <time class="time" datetime={createdAt.toISOString()} title={createdAt.toLocaleString()}>
        {formatTime(createdAt)}
      </time>
    </header>
    <div class="quote-body">
      {#each segments as segment, index (segmentKey(segment, index))}
        {#if segment.kind === 'text'}
          <NoteContent
            parts={segment.parts}
            embedded={nestedKeys}
            {showMedia}
            {profiles}
            media={segmentMediaLists[index]}
            {authorAction}
            onAuthorPress={authorAction && ((pubkey) => select(authorAction, pubkey))}
          />
        {:else}
          <div class="embed">
            <Self
              entity={segment.part}
              depth={depth + 1}
              {embeds}
              {profiles}
              {validationStatuses}
              {showAvatar}
              {showMedia}
              ancestorUnverified={ancestorUnverified || unverified}
              {onEmbedRequest}
              {noteAction}
              {authorAction}
              {onAction}
            />
          </div>
        {/if}
      {/each}
    </div>
  </article>
{:else if pending}
  <p class="quote loading" part="quote" use:whenVisible={request}>読み込み中…</p>
{:else}
  <!-- Nothing came back — or nothing is going to — so the reference is shown the
       way it was before this feature existed. A frame around it would claim
       there is a post here. -->
  <span class="chip" title={entity.raw} use:whenVisible={request}>{entity.label}</span>
{/if}

<style>
  .quote {
    /* Column, not the card's grid: the avatar lives in the header row and the
       body below it starts at the frame's edge — see the docblock above. */
    display: flex;
    /* What `.open` is inset against. */
    position: relative;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px solid var(--nt-quote-border, var(--nt-border, #e1e8ed));
    border-radius: var(--nt-quote-radius, var(--nt-radius, 10px));
    background: var(--nt-quote-bg, transparent);
    /* Three values, and each side is deliberate. Left and right are the part
       nesting pays for again at every level, so 6px costs a five-deep chain
       60px of width where 10px cost it 100px. The bottom is smaller than the
       top because the header row already carries 4px under itself
       (`.quote-header`'s margin), so an equal bottom reads as the larger gap
       of the two. */
    padding: var(--nt-quote-padding, 8px 6px 4px);
    /* Long unbroken content must not push the frame wider than the card. */
    min-width: 0;
    /* `1em` by default, and deliberately: this is relative to the box it sits
       in, so anything below 1 shrinks again at every level — five deep, 0.95
       lands at 0.77. The frame is what marks a quote as a quote. */
    font-size: var(--nt-quote-font-size, 1em);
  }

  .loading {
    margin: 0;
    color: var(--nt-muted, #657786);
  }

  .unverified {
    opacity: var(--nt-unverified-opacity, 0.6);
  }

  .quote-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    /* One line, always — the name and handle ellipsize instead of wrapping the
       header into the space the body is meant to have. */
    flex-wrap: nowrap;
    overflow: hidden;
    /* Avatar.svelte reads these, so nothing about it has to know it is nested. */
    --nt-avatar-size: var(--nt-quote-avatar-size, 20px);
    --nt-avatar-radius: var(--nt-quote-avatar-radius, 999px);
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
  }

  /* Reset to the text and image they wrap: the header looks the same either way. */
  .quote-avatar,
  .quote-author {
    appearance: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    /* A button centres its contents; this is the start of a text row. */
    text-align: start;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .quote-avatar {
    display: flex;
    flex: none;
  }

  .quote-author:hover .name,
  .quote-author:focus-visible .name {
    text-decoration: underline;
  }

  /* Inside the box: `.quote-header` clips its overflow, so a ring around the
     button is clipped away (as in `EventCard.svelte`). */
  .quote-author:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: -2px;
    border-radius: 4px;
  }

  .name {
    font-weight: 700;
    color: var(--nt-name-fg, inherit);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    /* Leaves room for the handle beside it — the split the card's header makes. */
    max-width: max(60%, 100% - 4.5em);
    flex: 0 0 auto;
  }

  .handle {
    color: var(--nt-handle-fg, var(--nt-muted, #657786));
    font-size: 0.85em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    /* The redundant half of the identity: it gives up its width first. */
    flex: 0 1 auto;
  }

  .time {
    margin-left: auto;
    color: var(--nt-muted, #657786);
    font-size: 0.8em;
    white-space: nowrap;
    flex: none;
  }

  /* The press target, covering the frame it belongs to. Transparent until it is
     hovered: the card is the affordance, and a tint under the pointer is the
     cue. */
  .open {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: inherit;
    background: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .open:hover {
    background: var(--nt-quote-hover-bg, rgb(15 20 25 / 4%));
  }

  /* Inside the frame, which the overlay matches exactly — a ring outside it
     would sit on the quoting note's own text. */
  .open:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: -2px;
  }

  /* Above the overlay, so what a reader could already act on keeps working: the
     header's author press, a link, a mention's press, a video's controls, and a
     nested quote's own press. Each nested card is then its own stacking
     context, so its overlay covers exactly its own frame. Scoped to a pressable
     card, because a z-index is not free: it also orders these against the
     card's date tooltip. */
  .pressable > .quote-header > .quote-avatar,
  .pressable > .quote-header > .quote-author,
  .pressable > .quote-body > .embed,
  .pressable > .quote-body :global(a),
  .pressable > .quote-body :global(button.mention),
  .pressable > .quote-body :global(video),
  .pressable > .quote-body :global(audio) {
    position: relative;
    z-index: 1;
  }

  /* Reads as the mention chip in NoteContent, because that is what it is: the
     reference nothing could be resolved for. */
  .chip {
    color: var(--nt-mention-fg, #1d9bf0);
    background: var(--nt-mention-bg, transparent);
    word-break: break-all;
  }

  /* See `.embed` in EventCard.svelte: the same collapsing-margin trick, so a
     run of adjacent quotes ends up `--nt-embed-gap` apart either way. The
     `.quote-body` wrapper exists to make it work at all — `.quote` is a flex
     column, where margins do not collapse, so the segments need a block box
     of their own to collapse inside. */
  .embed {
    margin: var(--nt-embed-gap, 8px) 0;
  }

  .embed:first-child {
    margin-top: 0;
  }

  .embed:last-child {
    margin-bottom: 0;
  }
</style>
