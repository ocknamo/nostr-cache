<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    /** Upstream relays to configure both live examples with. */
    relays: string;
    kinds: string;
    limit: string;
    /**
     * Database name the page's relay is already running with. The in-page
     * widget must ask for the same one: a page shares a single relay, and a
     * widget requesting different settings gets a console warning and the
     * running relay anyway.
     */
    dbName: string;
  }

  const { relays, kinds, limit, dbName }: Props = $props();

  const baseUrl = import.meta.env.BASE_URL;
  const origin = typeof location === 'undefined' ? '' : location.origin;

  const query = $derived(
    new URLSearchParams({ relays, kinds, limit, 'show-origin': 'true' }).toString()
  );
  const iframeSrc = $derived(`${baseUrl}embed/?${query}`);
  const embedOrigin = $derived(`${origin}${baseUrl}`);

  const iframeSnippet = $derived(
    `<iframe\n  src="${embedOrigin}embed/?relays=${encodeURIComponent(relays)}&kinds=${kinds}&limit=${limit}"\n  style="width: 100%; height: 480px; border: 0"\n  title="Nostr timeline"\n></iframe>`
  );

  const webComponentSnippet = $derived(
    `<script src="${embedOrigin}nostr-timeline.js"><\/script>\n\n<nostr-timeline\n  relays="${relays}"\n  kinds="${kinds}"\n  limit="${limit}"\n></nostr-timeline>`
  );

  /** Bounds on the height the embed page may ask for. */
  const MIN_IFRAME_HEIGHT = 160;
  const MAX_IFRAME_HEIGHT = 800;

  let iframeHeight = $state(480);
  let iframeElement = $state<HTMLIFrameElement | undefined>(undefined);
  /** Latest height the embed page asked for, so a resize can re-clamp it. */
  let lastRequestedHeight = 480;

  /**
   * Clamp a requested height, never letting the frame grow past the screen:
   * once its content no longer fits, the iframe scrolls internally, and a
   * nested scroll area taller than the viewport traps the page on a phone.
   */
  function clampIframeHeight(height: number): number {
    const viewportCap =
      typeof window === 'undefined' ? MAX_IFRAME_HEIGHT : Math.round(window.innerHeight * 0.8);
    const cap = Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_IFRAME_HEIGHT, viewportCap));
    return Math.min(Math.max(height, MIN_IFRAME_HEIGHT), cap);
  }

  onMount(() => {
    // The embed page reports its content height so the iframe can be sized to
    // it instead of guessing (the same snippet is documented in the README).
    const onMessage = (event: MessageEvent) => {
      // Only our own iframe may resize itself; any frame on the page can post.
      if (!iframeElement || event.source !== iframeElement.contentWindow) {
        return;
      }
      const data = event.data;
      if (data && data.type === 'nostr-timeline:height' && typeof data.height === 'number') {
        lastRequestedHeight = data.height;
        iframeHeight = clampIframeHeight(data.height);
      }
    };
    // Rotating the phone changes the cap, so re-clamp the last request.
    const onResize = () => {
      iframeHeight = clampIframeHeight(lastRequestedHeight);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', onResize);
    };
  });

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be denied; the snippet is selectable anyway.
    }
  }
</script>

<section class="panel">
  <h2>埋め込み</h2>
  <p class="panel-note">
    同じウィジェットを 2 通りの方法で埋め込めます。下の 2 つはどちらも実際に動いている実物です
    （このページ自身がウィジェットの利用者になっています）。
  </p>

  <div class="modes">
    <div class="mode">
      <h3>iframe</h3>
      <p class="mode-note">
        埋め込み先のページから完全に隔離されます。ウィジェットは iframe 自身の
        <code>globalThis</code> でリレーを動かすため、ホストページの WebSocket には触れません。
      </p>
      <iframe
        bind:this={iframeElement}
        title="Nostr timeline (iframe embed)"
        src={iframeSrc}
        style="height: {iframeHeight}px"
      ></iframe>
      <div class="snippet">
        <pre><code>{iframeSnippet}</code></pre>
        <button class="secondary" onclick={() => copy(iframeSnippet)}>コピー</button>
      </div>
    </div>

    <div class="mode">
      <h3>Web Component</h3>
      <p class="mode-note">
        埋め込み先のページ内で直接動きます。<code>globalThis.WebSocket</code> を差し替えて対象 URL
        だけを横取りするため、ページ内の他の Nostr クライアントとキャッシュを共有できます
        （対象外の URL は元の実装へそのまま通ります）。
      </p>
      <div class="live">
        <nostr-timeline {relays} {kinds} {limit} db-name={dbName}></nostr-timeline>
      </div>
      <div class="snippet">
        <pre><code>{webComponentSnippet}</code></pre>
        <button class="secondary" onclick={() => copy(webComponentSnippet)}>コピー</button>
      </div>
    </div>
  </div>

  <p class="footnote">
    ページ内に複数の <code>&lt;nostr-timeline&gt;</code> を置いた場合、リレーは 1 つだけ起動して
    共有されます（購読はウィジェットごとに独立）。最初に mount されたウィジェットの設定が採用され、
    異なる設定を要求したウィジェットには警告が出ます。設定を分けたい場合は iframe を使ってください。
  </p>
</section>

<style>
  .modes {
    display: grid;
    /* `min(320px, 100%)` so the two-column layout still collapses on screens
       narrower than the 320px track itself, instead of overflowing them. */
    grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    gap: 18px;
  }

  h3 {
    font-size: 0.95rem;
    margin-bottom: 2px;
  }

  .mode-note {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 10px;
  }

  iframe {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    display: block;
  }

  .live {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    padding: 8px;
    /* Same rule as the page's own timeline: a nested scroll area that is taller
       than the screen leaves no way to reach the rest of the page. */
    max-height: min(480px, 70vh);
    max-height: min(480px, 70dvh);
    overflow-y: auto;
  }

  .snippet {
    position: relative;
    margin-top: 10px;
  }

  /* Keep the first line clear of the floating copy button. */
  .snippet pre {
    padding-top: 34px;
  }

  .snippet button {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.3);
    color: #e6edf3;
    padding: 3px 10px;
    font-size: 0.75rem;
  }

  .footnote {
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 0.78rem;
  }
</style>
