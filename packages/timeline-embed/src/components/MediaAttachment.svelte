<script lang="ts">
  import type { MediaKind } from '../lib/content-parts.ts';

  interface Props {
    media: MediaKind;
    /** The attachment's URL. Already validated as `http(s)` by the parser. */
    url: string;
  }

  const { media, url }: Props = $props();

  /**
   * Set when the URL fails to load, so a dead link falls back to being a link
   * rather than leaving a broken-image icon in someone else's page.
   *
   * Keyed by URL for the same reason `Avatar.svelte` does it: a card can be
   * re-used for another event, and the flag must not survive that.
   */
  let failedUrl = $state<string | undefined>();
  const broken = $derived(failedUrl === url);

  /**
   * The file name, used as the image's accessible name.
   *
   * It is the only description an arbitrary URL carries. Falling back to the
   * host keeps the name non-empty for a URL that ends in a slash.
   */
  const label = $derived.by(() => {
    try {
      const parsed = new URL(url);
      const name = parsed.pathname.split('/').pop();
      return name ? decodeURIComponent(name) : parsed.host;
    } catch {
      return url;
    }
  });

  const fail = () => {
    failedUrl = url;
  };
</script>

{#if broken}
  <a class="fallback" href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a>
{:else if media === 'image'}
  <!-- Wrapped in a link so the full-size original is still one click away:
       the thumbnail here is capped to keep one photo from filling the embed. -->
  <a href={url} target="_blank" rel="noopener noreferrer nofollow">
    <img
      class="attachment"
      src={url}
      alt={label}
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      onerror={fail}
    />
  </a>
{:else if media === 'video'}
  <!-- `preload="none"`: nothing is fetched from the host until the reader
       presses play. Unlike <img>, a media element has no `referrerpolicy`, so
       playing one does send the embedding page's referrer — that is why the
       README lists media as a privacy trade-off. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video class="attachment" src={url} controls preload="none" playsinline onerror={fail}></video>
{:else}
  <audio class="attachment audio" src={url} controls preload="none" onerror={fail}></audio>
{/if}

<style>
  .attachment {
    display: block;
    max-width: 100%;
    /* Bounded height, so one tall photo does not push the rest of the timeline
       off the screen. `contain` because the aspect ratio is unknown.

       The default fits inside the card's own cap (--nt-card-max-height, 420px)
       with room for a header and an action row, so a photo post is shown whole
       rather than turned into a scroll box. Raising it past ~300px on a capped
       card buys nothing but a scrollbar — raise the card cap too. */
    max-height: var(--nt-media-max-height, 300px);
    object-fit: contain;
    border-radius: var(--nt-media-radius, 10px);
    background: var(--nt-media-bg, #e8eef5);
  }

  /* An audio player is a control strip, not a picture: it should span the card
     and has no height worth capping. */
  .audio {
    width: 100%;
    max-height: none;
    background: none;
  }

  .fallback {
    color: var(--nt-link-fg, #1d9bf0);
    word-break: break-all;
  }
</style>
