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
  import {
    type EmbedTarget,
    type EmbeddedEvent,
    embedKeys,
    embedTarget,
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
    /**
     * How deep this card sits: 1 for a quote on a timeline card, 2 for a quote
     * inside that, and so on. Passed to `selectEmbeds`, which stops at
     * `MAX_EMBED_DEPTH`.
     */
    depth: number;
    /** Every quoted event resolved so far, keyed by `embedKey`. */
    embeds?: Map<string, EmbeddedEvent>;
    /** Author profiles (kind 0), keyed by pubkey. */
    profiles?: Map<string, Profile>;
    /** The relay's verification verdicts, keyed by event id. */
    validationStatuses?: Map<string, ValidationStatus>;
    /** Render the quoted author's avatar. */
    showAvatar?: boolean;
    /** Render image / video / audio attachments found in the quoted body. */
    showMedia?: boolean;
    /**
     * Whether something above this card is already fading itself for want of a
     * verdict.
     *
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
  }: Props = $props();

  const target = $derived(embedTarget(entity.entity));
  const key = $derived(embedKey(entity.entity));
  // Not named `state`: a local by that name turns the `$state(…)` rune below
  // into a store subscription to it, which is not what either one means.
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
  /** Only the outermost unverified box draws the fade; see `ancestorUnverified`. */
  const fade = $derived(unverified && !ancestorUnverified);

  const parts = $derived(event ? parseContent(event.content) : []);
  /**
   * Nothing is lifted out of the quoted body unless it can become a card —
   * either because there is a way to fetch it, or because the caller has
   * already resolved some. See `resolvable` in `EventCard.svelte`.
   */
  const resolvable = $derived(Boolean(onEmbedRequest) || (embeds?.size ?? 0) > 0);
  const nested = $derived(resolvable ? selectEmbeds(parts, depth) : []);
  const nestedKeys = $derived(embedKeys(nested));

  /** Set once this card has actually asked for its event. */
  let requested = $state(false);
  /**
   * Whether a lookup is outstanding, and so worth a placeholder.
   *
   * Deliberately not "we have no event yet": with no `onEmbedRequest` nobody is
   * going to fetch one, and a placeholder would sit there for the life of the
   * page. The same goes for a `ready` entry with no event on it — a shape the
   * type allows and nothing produces, which must not read as "still coming".
   */
  const pending = $derived(
    target !== undefined &&
      (resolved?.status === 'loading' || (resolved === undefined && requested))
  );

  /**
   * The time of day only, matching the timeline card's header.
   *
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
</script>

{#if event && createdAt}
  <article class="quote" class:unverified={fade} part="quote" use:whenVisible={request}>
    <header class="quote-header">
      {#if showAvatar}
        <Avatar pubkey={event.pubkey} {profile} {name} />
      {/if}
      <span class="identity" title={event.pubkey}>
        <span class="name">{name}</span>
        {#if handle}
          <span class="handle">@{handle}</span>
        {/if}
      </span>
      <!-- Not the tooltip button the timeline card carries: a quote can be five
           deep, and five nested popovers inside one scrolling note is more
           chrome than the date is worth. The full date stays in the `title`. -->
      <time class="time" datetime={createdAt.toISOString()} title={createdAt.toLocaleString()}>
        {formatTime(createdAt)}
      </time>
    </header>
    <!-- No indent under the avatar above: the body runs the full width of the
         frame, which is the whole point of this component. -->
    <NoteContent
      content={event.content}
      {parts}
      embedded={nestedKeys}
      {showMedia}
      {profiles}
    />
    {#if nested.length > 0}
      <ul class="embeds">
        {#each nested as part (embedKey(part.entity))}
          <li>
            <Self
              entity={part}
              depth={depth + 1}
              {embeds}
              {profiles}
              {validationStatuses}
              {showAvatar}
              {showMedia}
              ancestorUnverified={ancestorUnverified || unverified}
              {onEmbedRequest}
            />
          </li>
        {/each}
      </ul>
    {/if}
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
       body below it starts at the frame's edge. */
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px solid var(--nt-quote-border, var(--nt-border, #e1e8ed));
    border-radius: var(--nt-quote-radius, var(--nt-radius, 10px));
    background: var(--nt-quote-bg, transparent);
    padding: var(--nt-quote-padding, 8px 10px);
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
    /* A quoted author's avatar is a marker beside the name rather than the
       column the card's is, so it is small and round. Avatar.svelte reads
       these, so nothing about that component has to know it is nested. */
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

  .name {
    font-weight: 700;
    color: var(--nt-name-fg, inherit);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    /* Never shrink, but never exceed the row either, and leave room for the
       handle beside it — the same split the timeline card's header makes. */
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

  /* Reads as the mention chip in NoteContent, because that is what it is: the
     reference nothing could be resolved for. */
  .chip {
    color: var(--nt-mention-fg, #1d9bf0);
    background: var(--nt-mention-bg, transparent);
    word-break: break-all;
  }

  .embeds {
    list-style: none;
    margin: var(--nt-embed-gap, 8px) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--nt-embed-gap, 8px);
    min-width: 0;
  }
</style>
