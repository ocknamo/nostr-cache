<script lang="ts">
  import { type BenchmarkResult, speedup } from '../lib/benchmark.ts';

  interface Props {
    result?: BenchmarkResult;
    running?: boolean;
    disabled?: boolean;
    error?: string;
    onRun: () => void;
  }

  const { result, running = false, disabled = false, error, onRun }: Props = $props();

  const factor = $derived(result ? speedup(result) : undefined);

  /** Longest bar in the chart, so both passes share a scale. */
  const scale = $derived(
    Math.max(result?.cold.timeToFirstEvent ?? 0, result?.warm.timeToFirstEvent ?? 0, 1)
  );

  function ms(value: number | undefined): string {
    if (value === undefined) {
      return '—';
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
  }

  function width(value: number | undefined): string {
    return `${Math.max(((value ?? 0) / scale) * 100, 1.5)}%`;
  }
</script>

<section class="panel">
  <h2>コールド / ウォーム計測</h2>
  <p class="panel-note">
    キャッシュを空にした 1 回目（コールド）と、同じ REQ をもう一度投げた 2 回目（ウォーム）を
    比べます。<strong>初回イベントまでの時間</strong>がキャッシュの効果が出るところで、ウォームは
    ネットワークを 1 往復もせずにローカルから即答します。
  </p>

  <button onclick={onRun} disabled={running || disabled}>
    {running ? '計測中…' : 'キャッシュを消して計測する'}
  </button>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if result}
    <div class="results">
      {#each [{ label: 'コールド（キャッシュ空）', pass: result.cold, kind: 'cold' }, { label: 'ウォーム（キャッシュ済み）', pass: result.warm, kind: 'warm' }] as row (row.kind)}
        <div class="row">
          <span class="label">{row.label}</span>
          <div class="bar-track">
            <div class="bar {row.kind}" style="width: {width(row.pass.timeToFirstEvent)}"></div>
          </div>
          <span class="value">{ms(row.pass.timeToFirstEvent)}</span>
        </div>
      {/each}
    </div>

    {#if factor !== undefined && factor > 1.05}
      <p class="verdict">
        初回イベントまで <strong>{factor.toFixed(1)}× 高速</strong>（{ms(
          result.cold.timeToFirstEvent
        )} → {ms(result.warm.timeToFirstEvent)}）
      </p>
    {:else if result.cold.eventCount === 0}
      <p class="verdict muted">
        上流からイベントを取得できませんでした。上流リレーを設定して再実行してください。
      </p>
    {/if}

    <!-- Scrolls on its own when the four columns no longer fit, so a phone
         gets a swipeable table instead of headings broken mid-word. Focusable
         because a scroll region has to be reachable without a pointer; the rule
         below flags exactly that pattern, which WCAG 2.1.1 asks for. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="table-scroll" tabindex="0" role="region" aria-label="計測結果の表">
      <table>
        <thead>
          <tr><th></th><th>初回イベント</th><th>EOSE</th><th>イベント数</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">コールド</th>
            <td>{ms(result.cold.timeToFirstEvent)}</td>
            <td>{result.cold.timedOut ? 'タイムアウト' : ms(result.cold.timeToEose)}</td>
            <td>{result.cold.eventCount}</td>
          </tr>
          <tr>
            <th scope="row">ウォーム</th>
            <td>{ms(result.warm.timeToFirstEvent)}</td>
            <td>{result.warm.timedOut ? 'タイムアウト' : ms(result.warm.timeToEose)}</td>
            <td>{result.warm.eventCount}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="footnote">
      EOSE はウォームでもあまり縮みません。これは仕様どおりで、リードスルーは常に REQ を上流へ
      転送してキャッシュを上流の状態に追従させ、上流の EOSE を集約するまでクライアントへの EOSE を
      保留するためです（上限は <code>upstreamEoseTimeout</code>）。上流を見に行かないキャッシュは
      速い代わりに古くなります。
    </p>
  {/if}
</section>

<style>
  .results {
    margin: 16px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: grid;
    grid-template-columns: 180px 1fr 90px;
    gap: 10px;
    align-items: center;
    font-size: 0.85rem;
  }

  .label {
    color: var(--muted);
  }

  .bar-track {
    background: #eef1f5;
    border-radius: 999px;
    height: 18px;
    overflow: hidden;
  }

  .bar {
    height: 100%;
    border-radius: 999px;
    transition: width 0.3s ease;
  }

  .bar.cold {
    background: var(--upstream);
  }

  .bar.warm {
    background: var(--cache);
  }

  .value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .verdict {
    margin: 12px 0;
    font-size: 1rem;
  }

  .verdict.muted {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .table-scroll {
    margin-top: 8px;
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  th,
  td {
    text-align: right;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  thead th,
  tbody th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
  }

  .footnote {
    margin: 12px 0 0;
    color: var(--muted);
    font-size: 0.78rem;
  }

  .error {
    color: #a4262c;
    font-size: 0.85rem;
  }

  @media (max-width: 720px) {
    .row {
      grid-template-columns: 1fr 70px;
    }

    .label {
      grid-column: 1 / -1;
    }
  }
</style>
