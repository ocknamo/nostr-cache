<script lang="ts">
  import {
    type ContentPart,
    type EntityPart,
    type MediaPart,
    inlineParts,
    mediaAsLinks,
    mediaParts,
    parseContent,
  } from '../lib/content-parts.ts';
  import { mentionLabel } from '../lib/content-preview.ts';
  import type { AuthorAction } from '../lib/event-actions.ts';
  import type { Profile } from '../lib/profile.ts';
  import MediaAttachment from './MediaAttachment.svelte';

  interface CommonProps {
    /**
     * Keys (`embedKey`) of the entities the caller renders as nested cards
     * elsewhere in the body, lifted out of this text the way attachments are so
     * a quote is not both a card and a chip. Applies by key to every
     * occurrence, not just the one that became a card: a second mention of an
     * event already carded elsewhere disappears from the text rather than
     * repeating as a chip. An entity not named here stays a chip.
     */
    embedded?: ReadonlySet<string>;
    /**
     * Render image / video / audio attachments. With this off the URLs stay in
     * the text as ordinary links, so nothing is hidden — the widget just never
     * asks an arbitrary host for bytes.
     */
    showMedia?: boolean;
    imageProxy?: string;
    /**
     * Profiles already fetched, keyed by pubkey, used to give a mention a name.
     *
     * Deliberately only a lookup: a mention of someone who is not already on
     * the timeline stays an abbreviated npub rather than costing the reader
     * another subscription per card.
     */
    profiles?: Map<string, Profile>;
    /**
     * The attachments to render, precomputed by the caller. A note split into
     * segments around its inline quote cards passes this (see
     * `segmentMedia`), so a URL already shown in an earlier segment is not
     * shown — and re-fetched — again in a later one. Unset, this component
     * computes it from `parts` itself, deduped only within what it was given.
     *
     * Never overrides `showMedia`: with media off nothing here is rendered,
     * so the switch stays a property of this component rather than something
     * every caller has to remember to apply to what it passes.
     */
    media?: MediaPart[];
    /**
     * Makes a `nostr:` mention of a person pressable, under this id. Only the
     * label reaches here: the event a press reports is the body's, which the
     * caller has and this component does not.
     */
    authorAction?: AuthorAction;
    /** Called on that press, with the mentioned person. */
    onAuthorPress?: (pubkey: string) => void;
  }

  type Props =
    | (CommonProps & {
        /** The event's raw `content`. */
        content: string;
        parts?: ContentPart[];
      })
    | (CommonProps & {
        /**
         * The parsed content, when the caller has it already — a note split
         * into segments around its inline quote cards passes each segment's
         * slice directly, since there is no single `content` string for one.
         */
        parts: ContentPart[];
        content?: never;
      });

  const {
    content,
    parts: given,
    embedded,
    showMedia = true,
    imageProxy,
    profiles,
    media: givenMedia,
    authorAction,
    onAuthorPress,
  }: Props = $props();

  const parts = $derived(given ?? parseContent(content ?? ''));
  const inline = $derived(
    showMedia ? inlineParts(parts, embedded) : mediaAsLinks(parts, embedded)
  );
  const media = $derived(showMedia ? (givenMedia ?? mediaParts(parts)) : []);

  /** The pubkey a mention points at, or undefined for a reference to an event. */
  function mentionPubkey(part: EntityPart): string | undefined {
    const { entity } = part;
    return entity.type === 'npub' || entity.type === 'nprofile' ? entity.pubkey : undefined;
  }

  /** Both halves or none: the packed markup below tests one value, not two. */
  const press = $derived(
    authorAction && onAuthorPress
      ? { label: authorAction.label, report: onAuthorPress }
      : undefined
  );
</script>

<!-- The markup below is deliberately packed onto as few lines as it can be:
     `.content` renders with `white-space: pre-wrap`, so any newline or indent
     between these tags would show up as real whitespace in the note. -->
{#if inline.length > 0}
  <p class="content">{#each inline as part, index (index)}{#if part.kind === 'text'}{part.text}{:else if part.kind === 'link'}<a
          href={part.href}
          target="_blank"
          rel="noopener noreferrer nofollow">{part.label}</a>{:else if part.kind === 'entity'}{@const pubkey = mentionPubkey(part)}{#if press && pubkey}<button
          type="button"
          class="mention"
          part="mention"
          title={part.raw}
          aria-label={`${press.label}: ${mentionLabel(part, profiles)}`}
          onclick={() => press.report(pubkey)}>{mentionLabel(part, profiles)}</button>{:else}<span
          class="mention"
          title={part.raw}>{mentionLabel(part, profiles)}</span>{/if}{/if}{/each}</p>
{/if}

{#if media.length > 0}
  <ul class="media">
    {#each media as item (item.url)}
      <li><MediaAttachment media={item.media} url={item.url} {imageProxy} /></li>
    {/each}
  </ul>
{/if}

<style>
  .content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .content a {
    color: var(--nt-link-fg, #1d9bf0);
    text-decoration: none;
    /* A URL has no spaces to break at, so without this a long one widens the
       card and hands the embedding page a horizontal scrollbar. */
    word-break: break-all;
  }

  .content a:hover,
  .content a:focus-visible {
    text-decoration: underline;
  }

  /* Not a link by design — the widget has no client to send a reader to — so a
     plain mention never picks up the hover underline that marks the real links
     beside it. */
  .mention {
    color: var(--nt-mention-fg, #1d9bf0);
    background: var(--nt-mention-bg, transparent);
    word-break: break-all;
  }

  /* The same chip, pressable. A button is one box, so unlike the span it
     replaces it cannot break across lines: a mention too long for the line it is
     on moves to the next one whole. */
  button.mention {
    appearance: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  button.mention:hover,
  button.mention:focus-visible {
    text-decoration: underline;
  }

  button.mention:focus-visible {
    outline: 2px solid var(--nt-focus, #1d9bf0);
    outline-offset: 1px;
  }

  .media {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* A grid item defaults to min-width:auto; without this a wide attachment
       would stretch the card. */
    min-width: 0;
  }
</style>
