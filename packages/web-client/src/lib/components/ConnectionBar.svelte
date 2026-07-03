<script lang="ts">
  import type { ConnectionStatus } from '../relay-connection.ts';

  interface Props {
    url: string;
    status: ConnectionStatus;
    onConnect: (url: string) => void;
    onDisconnect: () => void;
  }

  const { url, status, onConnect, onDisconnect }: Props = $props();

  // 初期値としてのみ url を使う (以降はユーザー入力を保持する)
  // svelte-ignore state_referenced_locally
  let inputUrl = $state(url);

  const statusLabels: Record<ConnectionStatus, string> = {
    disconnected: '未接続',
    connecting: '接続中…',
    connected: '接続済み',
    error: 'エラー',
  };

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = inputUrl.trim();
    if (trimmed.length > 0) {
      onConnect(trimmed);
    }
  }
</script>

<form class="panel connection-bar" onsubmit={submit}>
  <h2>リレー接続</h2>
  <div class="row">
    <input
      type="text"
      bind:value={inputUrl}
      placeholder="ws://nostr-cache.invalid または wss://relay.example.com"
      aria-label="リレーURL"
    />
    {#if status === 'connected'}
      <button type="button" class="secondary" onclick={onDisconnect}>切断</button>
    {:else}
      <button type="submit" disabled={status === 'connecting'}>接続</button>
    {/if}
    <span class="status status-{status}">{statusLabels[status]}</span>
  </div>
</form>

<style>
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  input {
    flex: 1;
  }

  .status {
    font-size: 0.85rem;
    white-space: nowrap;
    padding: 4px 10px;
    border-radius: 999px;
    background-color: #eff3f4;
    color: #536471;
  }

  .status-connected {
    background-color: #e7f5ec;
    color: #0a7d33;
  }

  .status-error {
    background-color: #fde8e9;
    color: #c0392b;
  }
</style>
