<script lang="ts">
  import type { MetricsSnapshot } from '@nostr-cache/timeline-embed';

  interface Props {
    metrics: MetricsSnapshot;
    /** Upstream relays with an established connection right now. */
    connectedUpstreams: number;
    /** Upstream relays configured (0 = cache-only). */
    configuredUpstreams: number;
    /** Events currently held in IndexedDB. */
    storedEvents: number;
  }

  const { metrics, connectedUpstreams, configuredUpstreams, storedEvents }: Props = $props();
</script>

<!-- The counters cover every event the relay served this page, which since the
     cards gained avatars includes the kind 0 profile lookups behind them — not
     just the notes visible in the timeline. -->
<dl class="metrics">
  <div class="metric cache">
    <dt>キャッシュ配信</dt>
    <dd>{metrics.cacheHits}</dd>
  </div>
  <div class="metric upstream">
    <dt>上流から取得</dt>
    <dd>{metrics.upstreamEvents}</dd>
  </div>
  <div class="metric">
    <dt>上流接続</dt>
    <dd>{connectedUpstreams} / {configuredUpstreams}</dd>
  </div>
  <div class="metric">
    <dt>キャッシュ保存数</dt>
    <dd>{storedEvents}</dd>
  </div>
</dl>

<style>
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
    margin: 0 0 14px;
  }

  .metric {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    background: #fff;
  }

  .metric.cache {
    background: var(--cache-bg);
    border-color: transparent;
  }

  .metric.upstream {
    background: var(--upstream-bg);
    border-color: transparent;
  }

  dt {
    font-size: 0.75rem;
    color: var(--muted);
  }

  dd {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .metric.cache dd {
    color: var(--cache);
  }

  .metric.upstream dd {
    color: var(--upstream);
  }
</style>
