<script lang="ts">
  import { DEFAULT_PROFILE_FRESHNESS, type EventAction } from '@nostr-cache/timeline-embed';
  import { onMount } from 'svelte';

  interface Props {
    /** Upstream relays to configure both live examples with. */
    relays: string;
    kinds: string;
    limit: string;
    /**
     * Seconds a cached profile is served for. Passed through to both examples so
     * the in-page one asks for the same relay the demo is already running — a
     * page shares one relay, and a differing setting only earns a warning.
     */
    profileFreshness: string;
    /** Render the diagnostic cache/upstream badges in both examples. */
    debug: boolean;
    /**
     * Database name the page's relay is already running with. The in-page
     * widget must ask for the same one: a page shares a single relay, and a
     * widget requesting different settings gets a console warning and the
     * running relay anyway.
     */
    dbName: string;
  }

  const { relays, kinds, limit, profileFreshness, debug, dbName }: Props = $props();

  const baseUrl = import.meta.env.BASE_URL;
  const origin = typeof location === 'undefined' ? '' : location.origin;

  /**
   * The action bar the examples below render under every card.
   *
   * Display only, on purpose. The widget ships no actions of its own — it holds
   * no key and never writes to a relay — so these exist to show what the row
   * looks like once an embedder declares one. Nothing here acts on a press: it
   * raises `nostr-timeline:action` (and a `postMessage` from the iframe, which
   * the height listener below drops as an unknown type) and stops there.
   *
   * Text icons rather than `material-icons`, which would have the widget inject
   * Google's stylesheet into this page — a third-party request the demo does not
   * otherwise make.
   */
  const DEMO_ACTIONS: EventAction[] = [
    { id: 'reply', label: '返信', icon: '💬' },
    { id: 'repost', label: 'リポスト', icon: '🔁' },
    { id: 'like', label: 'いいね', icon: '♡' },
    { id: 'zap', label: 'Zap', icon: '⚡' },
  ];
  /**
   * What actually reaches the widgets: a JSON string, not the array.
   *
   * Svelte hands a custom element's props over as properties when it can and as
   * attributes otherwise, and an array stringified into an attribute arrives as
   * `[object Object]`. The string is read the same way down both paths.
   */
  const actionsJson = JSON.stringify(DEMO_ACTIONS);
  /** The same list, laid out to be read inside the copyable HTML snippets. */
  const actionsSnippet = `[\n${DEMO_ACTIONS.map((action) => `    ${JSON.stringify(action)}`).join(',\n')}\n  ]`;

  const query = $derived(
    new URLSearchParams({
      relays,
      kinds,
      limit,
      'profile-freshness': profileFreshness,
      actions: actionsJson,
      // The badges are a diagnostic and the widget hides them by default; this
      // page turns them on because showing them is its whole point.
      ...(debug ? { debug: 'true' } : {}),
    }).toString()
  );
  const iframeSrc = $derived(`${baseUrl}embed/?${query}`);
  const embedOrigin = $derived(`${origin}${baseUrl}`);
  // Spelling out the default would teach readers to paste a value they do not
  // need; the live examples above still pass it, because they share the page's
  // relay and have to match whatever it was started with.
  const freshnessAttr = $derived(
    profileFreshness === String(DEFAULT_PROFILE_FRESHNESS) ? '' : profileFreshness
  );

  const iframeSnippet = $derived(
    `<iframe\n  src="${embedOrigin}embed/?relays=${encodeURIComponent(relays)}&kinds=${kinds}&limit=${limit}${freshnessAttr ? `&profile-freshness=${freshnessAttr}` : ''}&actions=${encodeURIComponent(actionsJson)}${debug ? '&debug' : ''}"\n  style="width: 100%; height: 480px; border: 0"\n  title="Nostr timeline"\n></iframe>`
  );

  const webComponentSnippet = $derived(
    `<script src="${embedOrigin}nostr-timeline.js"><\/script>\n\n<nostr-timeline\n  relays="${relays}"\n  kinds="${kinds}"\n  limit="${limit}"${freshnessAttr ? `\n  profile-freshness="${freshnessAttr}"` : ''}\n  actions='${actionsSnippet}'${debug ? '\n  debug' : ''}\n></nostr-timeline>`
  );

  /**
   * Subject for the live follow timeline below.
   *
   * Empty until someone pastes one: there is no sensible person to default to,
   * and the element refuses to subscribe without a valid `pubkey` anyway —
   * which is the point, since the only filter it could fall back to is the
   * entire global feed.
   */
  let followPubkey = $state('');
  /**
   * Whether the box holds something long enough to be a pubkey at all.
   *
   * A shape check, not validation — the element does the real parse. It is here
   * so a half-typed npub is not handed over on every keystroke, which would put
   * one "Invalid pubkey" warning per character into the console.
   */
  const followPubkeyReady = $derived(
    /^[0-9a-fA-F]{64}$/.test(followPubkey.trim()) || /^n(pub|profile)1\w{20,}$/.test(followPubkey.trim())
  );
  const followSnippet = $derived(
    `<script src="${embedOrigin}nostr-timeline.js"><\/script>\n\n<nostr-follow-timeline\n  pubkey="${followPubkey || 'npub1...'}"\n  relays="${relays}"\n  limit="${limit}"\n  actions='${actionsSnippet}'\n></nostr-follow-timeline>`
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
  <p class="panel-note">
    各投稿の下に並ぶ 💬 🔁 ♡ ⚡ は、このページが <code>actions</code> で宣言したボタンです。
    ウィジェット自身はアクションを 1 つも持ちません（鍵を持たない読み取り専用の表示器なので、
    返信・リポスト・いいね・Zap はいずれも埋め込む側の仕事です）。<strong
      >このデモでは押しても何も起きません</strong
    >
    — 押下は <code>nostr-timeline:action</code> イベント（iframe なら
    <code>postMessage</code>）で通知されるだけで、このページはそれを使っていません。
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
        <!-- The string form rather than a bare `debug`: Svelte would set a bare
             attribute as the custom element's *property* (a real boolean),
             while plain HTML sets the attribute. The widget accepts both, but
             the explicit string is also what turns the flag back off when the
             form's checkbox is cleared. -->
        <nostr-timeline
          {relays}
          {kinds}
          {limit}
          db-name={dbName}
          profile-freshness={profileFreshness}
          actions={actionsJson}
          debug={debug ? 'true' : 'false'}
        ></nostr-timeline>
      </div>
      <div class="snippet">
        <pre><code>{webComponentSnippet}</code></pre>
        <button class="secondary" onclick={() => copy(webComponentSnippet)}>コピー</button>
      </div>
    </div>
  </div>

  <h3 class="follow-heading">フォロータイムライン</h3>
  <p class="mode-note">
    <code>&lt;nostr-follow-timeline&gt;</code> は、指定した人が NIP-02（kind 3）でフォローしている
    人たちの投稿を並べます。フィルタを書くのではなく<strong>人を 1 人指定する</strong>ので、
    購読は「フォローリストを引く → その authors で購読する」の 2 段階になります。
    フォローリストも replaceable としてキャッシュに載るため、2 回目以降のロードでは
    上流に問い合わせずに即座に出ます。
  </p>

  <label class="follow-input">
    <span>pubkey（npub / nprofile / hex）</span>
    <input
      type="text"
      bind:value={followPubkey}
      placeholder="npub1..."
      spellcheck="false"
      autocomplete="off"
    />
  </label>

  {#if followPubkeyReady}
    <div class="live">
      <nostr-follow-timeline
        pubkey={followPubkey.trim()}
        {relays}
        {limit}
        db-name={dbName}
        profile-freshness={profileFreshness}
        actions={actionsJson}
        debug={debug ? 'true' : 'false'}
      ></nostr-follow-timeline>
    </div>
  {:else}
    <p class="footnote">
      pubkey を入れると、ここに実際のフォロータイムラインが出ます（hex / npub / nprofile）。
    </p>
  {/if}

  <div class="snippet">
    <pre><code>{followSnippet}</code></pre>
    <button class="secondary" onclick={() => copy(followSnippet)}>コピー</button>
  </div>

  <p class="footnote">
    iframe で使う場合は<strong>別のページ</strong>です:
    <code>{embedOrigin}embed/follow/?pubkey=npub1...&amp;relays=…</code>。
    入口を分けているのは、この要素に <code>authors</code> も <code>filters</code> も
    無いからです — 1 ページで両方を受けると、<code>?pubkey=…&amp;filters=…</code>
    のような URL が「<code>filters</code> が黙って無視される」形で通ってしまいます。
  </p>

  <p class="footnote">
    ページ内に複数の <code>&lt;nostr-timeline&gt;</code> を置いた場合、リレーは 1 つだけ起動して
    共有されます（購読はウィジェットごとに独立）。最初に mount されたウィジェットの設定が採用され、
    異なる設定を要求したウィジェットには警告が出ます。設定を分けたい場合は iframe を使ってください。
  </p>

  <p class="footnote">
    <code>debug</code> を付けると各投稿に <code>cache</code> / <code>upstream</code>
    バッジが出ます（上の設定フォームのチェックボックスがページ全体に即時反映されます）。動作確認用の表示なので、
    実際の埋め込みでは外してください。<code>profile-freshness</code> は
    プロフィール（kind 0）のキャッシュを上流に問い合わせ直さずに使う秒数です。
  </p>

  <p class="footnote">
    アバターはプロフィール（kind 0）が指す任意の URL から読み込まれるため、閲覧者の IP が
    その画像ホストに渡ります。避けたい場合は <code>show-avatars="false"</code>
    （iframe なら <code>&amp;show-avatars=false</code>）を指定してください。表示名は
    そのまま表示されます。
  </p>

  <p class="footnote">
    本文中の URL はリンクになり、画像・動画・音声は投稿者が指定したホストから直接埋め込まれます
    （アバターと同じく閲覧者の IP がそのホストに渡ります）。避けたい場合は
    <code>show-media="false"</code>（iframe なら <code>&amp;show-media=false</code>）を
    指定してください。URL はリンクとして残ります。<code>nostr:</code> のメンションは
    短縮表示するだけで、リンクにはしません。
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

  .follow-heading {
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  .follow-input {
    display: block;
    margin-bottom: 10px;
  }

  .follow-input span {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
    margin-bottom: 4px;
  }

  .follow-input input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.85rem;
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
