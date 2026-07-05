<script lang="ts">
  import type { Filter } from '@nostr-cache/shared';
  import { buildFilter, parseFilterJson } from '../filter-form.ts';

  interface Props {
    onSubmit: (filter: Filter) => void;
    disabled?: boolean;
  }

  const { onSubmit, disabled = false }: Props = $props();

  let mode = $state<'simple' | 'json'>('simple');
  let kinds = $state('1');
  let authors = $state('');
  let ids = $state('');
  let limit = $state('100');
  let since = $state('');
  let until = $state('');
  let json = $state('{\n  "kinds": [1],\n  "limit": 100\n}');
  let error = $state('');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const result =
      mode === 'simple'
        ? buildFilter({ kinds, authors, ids, limit, since, until })
        : parseFilterJson(json);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = '';
    onSubmit(result.filter);
  }
</script>

<form class="panel filter-form" onsubmit={submit}>
  <h2>フィルタ</h2>

  <div class="mode-toggle" role="tablist">
    <label>
      <input type="radio" bind:group={mode} value="simple" /> フォーム
    </label>
    <label>
      <input type="radio" bind:group={mode} value="json" /> JSON
    </label>
  </div>

  {#if mode === 'simple'}
    <div class="grid">
      <label>
        kinds (カンマ区切り)
        <input type="text" bind:value={kinds} placeholder="1, 30023" />
      </label>
      <label>
        limit
        <input type="text" bind:value={limit} placeholder="100" />
      </label>
      <label>
        authors (pubkey, カンマ区切り)
        <input type="text" bind:value={authors} placeholder="npub… の hex 形式" />
      </label>
      <label>
        ids (event id, カンマ区切り)
        <input type="text" bind:value={ids} />
      </label>
      <label>
        since (unixtime)
        <input type="text" bind:value={since} />
      </label>
      <label>
        until (unixtime)
        <input type="text" bind:value={until} />
      </label>
    </div>
  {:else}
    <label class="json-label">
      NIP-01 フィルタ (JSON)
      <textarea rows="5" bind:value={json}></textarea>
    </label>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <button type="submit" {disabled}>フィルタを適用</button>
</form>

<style>
  .mode-toggle {
    display: flex;
    gap: 16px;
    margin-bottom: 10px;
    font-size: 0.9rem;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  }

  .grid label,
  .json-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    color: #536471;
  }

  .json-label {
    margin-bottom: 12px;
  }

  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .error {
    color: #c0392b;
    font-size: 0.85rem;
    margin: 0 0 10px;
  }

  @media (max-width: 520px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
