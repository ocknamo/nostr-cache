<script lang="ts">
  import {
    type ContentPart,
    type EntityPart,
    inlineParts,
    mediaAsLinks,
    mediaParts,
    parseContent,
  } from '../lib/content-parts.ts';
  import type { Profile } from '../lib/profile.ts';
  import MediaAttachment from './MediaAttachment.svelte';

  interface Props {
    /**
     * The event's raw `content`. Unused when `parts` is given — a note split
     * into segments around its inline quote cards passes each segment's slice
     * of `parts` directly, since there is no single `content` string for one.
     */
    content?: string;
    /**
     * The parsed content, when the caller has it already: a card that renders
     * quoted events has to parse the body to find them. Unset, this component
     * parses `content` itself, as it always has.
     */
    parts?: ContentPart[];
    /**
     * Keys (`embedKey`) of the entities the caller renders as nested cards below
     * this text, lifted out of the paragraph the way attachments are so a quote
     * is not both a card and a chip. An entity not named here stays a chip.
     */
    embedded?: ReadonlySet<string>;
    /**
     * Render image / video / audio attachments. With this off the URLs stay in
     * the text as ordinary links, so nothing is hidden — the widget just never
     * asks an arbitrary host for bytes.
     */
    showMedia?: boolean;
    /**
     * Profiles already fetched, keyed by pubkey, used to give a mention a name.
     *
     * Deliberately only a lookup: a mention of someone who is not already on
     * the timeline stays an abbreviated npub rather than costing the reader
     * another subscription per card.
     */
    profiles?: Map<string, Profile>;
  }

  const { content = '', parts: given, embedded, showMedia = true, profiles }: Props = $props();

  const parts = $derived(given ?? parseContent(content));
  const inline = $derived(
    showMedia ? inlineParts(parts, embedded) : mediaAsLinks(parts, embedded)
  );
  const media = $derived(showMedia ? mediaParts(parts) : []);

  /**
   * What to show for a mention.
   *
   * `@name` when the author is already known to this timeline, the abbreviated
   * bech32 otherwise. Event and address references have no name to resolve, so
   * they always read as the abbreviated entity.
   */
  function mentionLabel(part: EntityPart): string {
    const { entity } = part;
    if (entity.type === 'npub' || entity.type === 'nprofile') {
      const profile = profiles?.get(entity.pubkey);
      const name = profile?.displayName ?? profile?.name;
      if (name) {
        return `@${name}`;
      }
    }
    return part.label;
  }
</script>

<!-- The markup below is deliberately packed onto as few lines as it can be:
     `.content` renders with `white-space: pre-wrap`, so any newline or indent
     between these tags would show up as real whitespace in the note. -->
{#if inline.length > 0}
  <p class="content">{#each inline as part, index (index)}{#if part.kind === 'text'}{part.text}{:else if part.kind === 'link'}<a
          href={part.href}
          target="_blank"
          rel="noopener noreferrer nofollow">{part.label}</a>{:else if part.kind === 'entity'}<span
          class="mention"
          title={part.raw}>{mentionLabel(part)}</span>{/if}{/each}</p>
{/if}

{#if media.length > 0}
  <ul class="media">
    {#each media as item (item.url)}
      <li><MediaAttachment media={item.media} url={item.url} /></li>
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

  /* Not a link by design — the widget has no client to send a reader to — so it
     never picks up the hover underline that marks the real links beside it. */
  .mention {
    color: var(--nt-mention-fg, #1d9bf0);
    background: var(--nt-mention-bg, transparent);
    word-break: break-all;
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
