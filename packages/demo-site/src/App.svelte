<script lang="ts">
  // Side-effect import: registers <nostr-timeline> so the embed panel can use
  // the real widget rather than a lookalike.
  import '@nostr-cache/timeline-embed/embed';
  import {
    DEFAULT_PROFILE_FRESHNESS,
    type MetricsSnapshot,
    type TimelineState,
    Timeline,
    TimelineController,
    getRelayHostRefCount,
    parseFilter,
    parseFreshness,
    parseRelays,
  } from '@nostr-cache/timeline-embed';
  import { onMount, tick } from 'svelte';
  import BenchmarkPanel from './components/BenchmarkPanel.svelte';
  import EmbedPanel from './components/EmbedPanel.svelte';
  import MetricsBar from './components/MetricsBar.svelte';
  import RelaySettings from './components/RelaySettings.svelte';
  import { type BenchmarkResult, runBenchmark } from './lib/benchmark.ts';

  const DEFAULT_SETTINGS = {
    relays: 'wss://yabu.me',
    kinds: '1',
    limit: '50',
    /** Seconds a cached kind 0 is served for — the widget's own default. */
    profileFreshness: String(DEFAULT_PROFILE_FRESHNESS),
  };
  /**
   * `debug` for everything this page renders — its own timeline and both embed
   * examples — so the checkbox means one thing wherever the reader looks.
   *
   * Deliberately not part of `settings`: it only decides whether a badge is
   * rendered, so making it wait for the "apply and restart" round trip — which
   * also wipes the metrics and the benchmark result — would charge a relay
   * restart for a display toggle.
   */
  let debug = $state(true);
  /** How often the IndexedDB row count is refreshed. */
  const STORED_COUNT_INTERVAL_MS = 2000;
  /**
   * IndexedDB database for this page's relay. The in-page embed example has to
   * request the same one — a page runs a single shared relay, so a widget
   * asking for different settings is warned and handed the running relay.
   */
  const DEMO_DB_NAME = 'nostr-cache-demo';

  /** What the form is showing; only copied into `settings` on apply. */
  let draft = $state({ ...DEFAULT_SETTINGS });
  /** What the running relay and the embedded widgets are actually using. */
  let settings = $state({ ...DEFAULT_SETTINGS });
  let controller: TimelineController | undefined;
  let timeline = $state<TimelineState>({
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    eose: false,
  });
  let metrics = $state<MetricsSnapshot>({ cacheHits: 0, upstreamEvents: 0, delivered: 0 });
  let connectedUpstreams = $state(0);
  let storedEvents = $state(0);
  let embedMounted = $state(false);
  let restarting = $state(false);
  let benchmarkResult = $state<BenchmarkResult | undefined>(undefined);
  let benchmarkRunning = $state(false);
  let benchmarkError = $state<string | undefined>(undefined);
  let restartError = $state<string | undefined>(undefined);

  const relays = $derived(parseRelays(settings.relays));
  const filter = $derived(parseFilter({ kinds: settings.kinds, limit: settings.limit }));
  // Undefined for an unparseable entry, which leaves the widget's own default in
  // place — the same thing an embed with a typo'd attribute gets.
  const profileFreshness = $derived(parseFreshness(settings.profileFreshness));

  let unsubscribeMetrics: (() => void) | undefined;
  let countTimer: ReturnType<typeof setInterval> | undefined;

  async function startSession(): Promise<void> {
    controller = new TimelineController({
      host: { upstreamRelays: relays, dbName: DEMO_DB_NAME, profileFreshness },
      onChange: (next) => {
        timeline = next;
      },
    });
    await controller.start([filter]);

    const host = controller.host;
    unsubscribeMetrics = host?.metrics.subscribe(() => {
      metrics = host.metrics.snapshot();
      connectedUpstreams = host.getConnectedUpstreams();
    });
    metrics = host?.metrics.snapshot() ?? metrics;
    await refreshStoredCount();

    // Bring the embed panel up only once the relay is running, so its widget
    // joins the existing host instead of racing to start a second one.
    embedMounted = true;
  }

  async function stopSession(): Promise<void> {
    unsubscribeMetrics?.();
    unsubscribeMetrics = undefined;
    // Unmount the embedded widgets first: each holds its own claim on the
    // shared relay, and the relay only shuts down once every claim is released.
    embedMounted = false;
    await tick();
    await controller?.stop();
    controller = undefined;
    await waitForRelayRelease();
  }

  /**
   * Wait until nothing holds the shared relay, so the next session starts a
   * genuinely new one (with the new upstream relays) instead of silently
   * reusing the running one.
   *
   * @throws If a holder is still hanging on when the timeout expires — carrying
   *   on regardless would show the new settings in the form while the old relay
   *   keeps running, with only a console warning to say so.
   */
  async function waitForRelayRelease(timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();
    while (getRelayHostRefCount() > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `リレーの解放待ちがタイムアウトしました（残り ${getRelayHostRefCount()} 件）`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function applySettings(): Promise<void> {
    if (restarting) {
      return;
    }
    restarting = true;
    restartError = undefined;
    try {
      await stopSession();
      settings = { ...draft };
      benchmarkResult = undefined;
      metrics = { cacheHits: 0, upstreamEvents: 0, delivered: 0 };
      connectedUpstreams = 0;
      await startSession();
    } catch (error) {
      restartError = `リレーの再起動に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      restarting = false;
    }
  }

  async function refreshStoredCount(): Promise<void> {
    try {
      storedEvents = (await controller?.host?.storage.count()) ?? 0;
    } catch {
      // A failed count only blanks one counter; nothing else depends on it.
    }
  }

  async function runBenchmarkNow(): Promise<void> {
    const host = controller?.host;
    if (!host || benchmarkRunning) {
      return;
    }
    benchmarkRunning = true;
    benchmarkError = undefined;
    // Close the live subscription first: it reads through to the upstream and
    // keeps refilling the cache, which would contaminate the cold pass.
    controller?.suspend();
    try {
      benchmarkResult = await runBenchmark({
        interceptUrl: host.interceptUrl,
        filter,
        clearCache: async () => {
          await host.storage.clear();
          // Origins recorded against the wiped events would mislabel the
          // cold pass as cache hits.
          host.metrics.reset();
        },
      });
      await refreshStoredCount();
    } catch (error) {
      benchmarkError = `計測に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      benchmarkRunning = false;
      // The benchmark's own connections pulled every event through the upstream
      // without classifying the deliveries, leaving sightings that would
      // otherwise be attributed to the resumed timeline and label genuine cache
      // reads as upstream fetches. The benchmark is a separate activity, so its
      // traffic should not carry into the live counters.
      controller?.host?.metrics.reset();
      metrics = { cacheHits: 0, upstreamEvents: 0, delivered: 0 };
      // Resume the live timeline. Its previous events were wiped by the cold
      // pass, so re-subscribing is what makes the view match the cache again.
      controller?.applyFilter([filter]);
    }
  }

  onMount(() => {
    void startSession();
    countTimer = setInterval(() => {
      void refreshStoredCount();
      connectedUpstreams = controller?.host?.getConnectedUpstreams() ?? 0;
    }, STORED_COUNT_INTERVAL_MS);

    return () => {
      clearInterval(countTimer);
      void stopSession();
    };
  });
</script>

<div class="page">
  <header>
    <h1>nostr-cache — 透過キャッシュのデモ</h1>
    <p class="lead">
      ブラウザ内で Nostr リレーを起動し、上流の実リレーの手前に<strong>透過キャッシュ</strong>として
      挟みます。クライアントは素の <code>new WebSocket()</code> を使うだけで、対象 URL への接続は
      ネットワークに出ずにページ内のリレーへ届きます（リードスルー / ライトスルー）。
    </p>
    <p class="links">
      <a href="https://github.com/ocknamo/nostr-cache">GitHub</a>
    </p>
  </header>

  <section class="panel">
    <h2>ライブタイムライン</h2>
    <p class="panel-note">
      各イベントの <span class="chip cache">cache</span> /
      <span class="chip upstream">upstream</span> バッジが、そのイベントを IndexedDB
      から返したのか上流から取ってきたのかを示します（<code>debug</code> を外すと、
      実際の埋め込みと同じくバッジは出ません）。ページをリロードすると、同じイベントが
      今度は <span class="chip cache">cache</span> で返るのが見えます。
      表示名とアバターは kind 0（プロフィール）を別途購読して取得しており、これもキャッシュ
      されるため、リロード後は上流を待たずに表示されます。上の計測値はこの取得分も含みます。
    </p>

    <RelaySettings
      bind:relays={draft.relays}
      bind:kinds={draft.kinds}
      bind:limit={draft.limit}
      bind:profileFreshness={draft.profileFreshness}
      bind:debug
      busy={restarting}
      onApply={applySettings}
    />

    <div class="status">
      接続: <strong>{timeline.status}</strong>
      {#if relays.length === 0}
        <span class="warn">上流リレー未設定（保存済みイベントのみ返します）</span>
      {/if}
      {#if restartError}
        <span class="warn">{restartError}</span>
      {/if}
      {#if timeline.error}
        <span class="warn">{timeline.error}</span>
      {/if}
    </div>

    <MetricsBar
      {metrics}
      {connectedUpstreams}
      configuredUpstreams={relays.length}
      {storedEvents}
    />

    <div class="timeline-scroll">
      <Timeline
        events={timeline.events}
        eose={timeline.eose}
        origins={timeline.origins}
        showOrigin={debug}
        validationStatuses={timeline.validationStatuses}
        profiles={timeline.profiles}
        onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
      />
    </div>
  </section>

  <BenchmarkPanel
    result={benchmarkResult}
    running={benchmarkRunning}
    disabled={restarting}
    error={benchmarkError}
    onRun={runBenchmarkNow}
  />

  {#if embedMounted}
    <EmbedPanel
      relays={settings.relays}
      kinds={settings.kinds}
      limit={settings.limit}
      profileFreshness={settings.profileFreshness}
      {debug}
      dbName={DEMO_DB_NAME}
    />
  {/if}

  <footer>
    <p>
      キャッシュはブラウザの IndexedDB に保存されます。署名検証はリレーが遅延実行し、検証済みの
      イベントには ✓ が付きます。
    </p>
  </footer>
</div>

<style>
  .page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 28px 20px 60px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  header h1 {
    font-size: 1.5rem;
  }

  .lead {
    color: var(--muted);
    margin: 8px 0 0;
    font-size: 0.9rem;
  }

  .links {
    margin: 8px 0 0;
    font-size: 0.85rem;
  }

  .status {
    margin: 14px 0 12px;
    font-size: 0.85rem;
    color: var(--muted);
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }

  .warn {
    color: #8a6100;
    background: #fff6e0;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.78rem;
  }

  .chip {
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .chip.cache {
    background: var(--cache-bg);
    color: var(--cache);
  }

  .chip.upstream {
    background: var(--upstream-bg);
    color: var(--upstream);
  }

  .timeline-scroll {
    /* Never taller than the screen: a scroll area that outgrows the viewport
       leaves no way to reach the rest of the page on a phone. */
    max-height: min(520px, 70vh);
    /* dvh tracks the collapsing address bar on mobile Safari; the vh line above
       stays as the fallback. */
    max-height: min(520px, 70dvh);
    overflow-y: auto;
    padding-right: 4px;
  }

  footer {
    color: var(--muted);
    font-size: 0.8rem;
  }

  @media (max-width: 600px) {
    .page {
      padding: 20px 12px 48px;
      gap: 16px;
    }

    header h1 {
      font-size: 1.25rem;
    }
  }
</style>
