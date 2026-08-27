<script lang="ts">
  import { readUrl } from '../lib/content-parts.ts';
  import { type OgpData, requestOgp } from '../lib/ogp.ts';
  import { whenVisible } from '../lib/when-visible.ts';

  interface Props {
    /** CORS proxy the page is fetched through; see `lib/ogp.ts`. */
    proxy: string;
    /** The link to preview. */
    url: string;
  }

  const { proxy, url }: Props = $props();

  /**
   * Re-validated here rather than trusted from the caller: this component is
   * exported, so `href` gets the same check at the sink that every other URL in
   * the package does. Nothing renders and nothing is fetched without one.
   */
  const href = $derived(readUrl(url)?.href);

  /**
   * Keyed by URL, as in `MediaAttachment.svelte`: `<nostr-post>` reuses one card
   * for the next post, and the previous preview must not survive that.
   */
  let loaded = $state<{ url: string; data?: OgpData } | undefined>();
  let imageFailedUrl = $state<string | undefined>();

  const data = $derived(loaded && loaded.url === href ? loaded.data : undefined);
  const image = $derived(href !== undefined && imageFailedUrl === href ? undefined : data?.image);

  const load = () => {
    const target = href;
    if (target === undefined) {
      return;
    }
    requestOgp(proxy, target).then((result) => {
      // A slow answer for the post this card used to show must not land on the
      // one it shows now — it would blank a card that had already resolved.
      if (target !== href) {
        return;
      }
      loaded = { url: target, data: result };
    });
  };
</script>

<!-- Keyed so the lookup runs again for a new link: `whenVisible` reports once
     per element, and would otherwise stay spent from the previous post. The
     proxy is in the key too, since it decides what the answer is. -->
{#key `${proxy}\n${href}`}
  <div use:whenVisible={load}>
    {#if data && href}
      <a class="ogp" part="ogp" {href} target="_blank" rel="noopener noreferrer nofollow">
        {#if image}
          <!-- `alt=""`: the title beside it is the link's accessible name, so a
               second description of the same link only repeats it. -->
          <img
            class="image"
            part="ogp-image"
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            onerror={() => {
              imageFailedUrl = href;
            }}
          />
        {/if}
        <span class="body">
          {#if data.siteName}<span class="site" part="ogp-site">{data.siteName}</span>{/if}
          <span class="title" part="ogp-title">{data.title}</span>
          {#if data.description}<span class="description" part="ogp-description"
              >{data.description}</span
            >{/if}
        </span>
      </a>
    {/if}
  </div>
{/key}

<style>
  .ogp {
    display: block;
    margin: var(--nt-ogp-gap, 8px) 0 0;
    border: 1px solid var(--nt-ogp-border, var(--nt-border, #e1e8ed));
    border-radius: var(--nt-ogp-radius, var(--nt-radius, 10px));
    /* Clips the thumbnail to the rounded corner. */
    overflow: hidden;
    background: var(--nt-ogp-bg, transparent);
    color: inherit;
    text-decoration: none;
  }

  .ogp:hover,
  .ogp:focus-visible {
    background: var(--nt-ogp-hover-bg, rgba(15, 20, 25, 0.04));
  }

  .image {
    display: block;
    width: 100%;
    height: var(--nt-ogp-image-height, 160px);
    object-fit: cover;
    background: var(--nt-media-bg, #e8eef5);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
  }

  .site {
    font-size: 0.8rem;
    color: var(--nt-muted, #657786);
  }

  .title {
    font-weight: 600;
  }

  .description {
    font-size: 0.9rem;
    color: var(--nt-muted, #657786);
  }

  /* Two lines each: the card is a hint about the link, and a page is free to
     carry an entire article's worth of description. */
  .title,
  .description {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    word-break: break-word;
  }
</style>
