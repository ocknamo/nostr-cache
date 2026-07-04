<script lang="ts">
  import type { Filter, NostrEvent } from '@nostr-cache/shared';
  import { onMount } from 'svelte';
  import ConnectionBar from './lib/components/ConnectionBar.svelte';
  import FilterForm from './lib/components/FilterForm.svelte';
  import PostForm from './lib/components/PostForm.svelte';
  import Timeline from './lib/components/Timeline.svelte';
  import { EventSigner } from './lib/event-signer.ts';
  import { LOCAL_RELAY_URL, startLocalRelay } from './lib/local-relay.ts';
  import type { ConnectionStatus } from './lib/relay-connection.ts';
  import { RelayConnection } from './lib/relay-connection.ts';
  import { insertEvent } from './lib/timeline-utils.ts';

  const DEFAULT_FILTER: Filter = { kinds: [1], limit: 100 };
  const MAX_NOTICES = 5;

  // 上流実リレー（例: ['wss://nos.lol']）。空なら従来どおりローカル保存分のみ返す
  // 独立キャッシュとして動作する。URL を入れるとリード/ライトスルーの透過キャッシュ
  // （上流の手前に挟まる本来の姿）になる。
  const UPSTREAM_RELAYS: string[] = [];

  let status = $state<ConnectionStatus>('disconnected');
  let relayUrl = $state(LOCAL_RELAY_URL);
  let events = $state<NostrEvent[]>([]);
  let eoseReceived = $state(false);
  let notices = $state<string[]>([]);
  let localRelayReady = $state(false);
  let currentFilter: Filter = DEFAULT_FILTER;
  let currentSubId: string | null = null;
  let subSeq = 0;

  const signer = new EventSigner();
  const connection = new RelayConnection({
    onStatusChange: (next) => {
      status = next;
    },
    onNotice: (message) => pushNotice(`NOTICE: ${message}`),
    onOk: (eventId, accepted, message) => {
      pushNotice(
        accepted
          ? `投稿を受理しました (${eventId.slice(0, 8)}…)`
          : `投稿が拒否されました${message ? `: ${message}` : ''}`
      );
    },
  });

  function pushNotice(message: string) {
    notices = [...notices, message].slice(-MAX_NOTICES);
  }

  async function connectTo(url: string) {
    relayUrl = url;
    currentSubId = null;
    try {
      await connection.connect(url);
      applyFilter(currentFilter);
    } catch (error) {
      pushNotice(`接続に失敗しました: ${(error as Error).message}`);
    }
  }

  function disconnect() {
    currentSubId = null;
    connection.disconnect();
  }

  function applyFilter(filter: Filter) {
    currentFilter = filter;
    if (currentSubId) {
      connection.unsubscribe(currentSubId);
      currentSubId = null;
    }
    events = [];
    eoseReceived = false;
    if (!connection.isConnected) {
      return;
    }
    subSeq += 1;
    const subId = `timeline-${subSeq}`;
    currentSubId = subId;
    connection.subscribe(subId, [filter], {
      onEvent: (event) => {
        events = insertEvent(events, event);
      },
      onEose: () => {
        eoseReceived = true;
      },
      onClosed: (message) => {
        pushNotice(`購読が閉じられました${message ? `: ${message}` : ''}`);
      },
    });
  }

  async function post(content: string): Promise<boolean> {
    if (!connection.isConnected) {
      pushNotice('リレーに接続していないため投稿できません');
      return false;
    }
    try {
      const event = await signer.signTextNote(content);
      connection.publish(event);
      return true;
    } catch (error) {
      pushNotice(`投稿に失敗しました: ${(error as Error).message}`);
      return false;
    }
  }

  onMount(() => {
    let handle: Awaited<ReturnType<typeof startLocalRelay>> | undefined;
    (async () => {
      try {
        handle = await startLocalRelay(LOCAL_RELAY_URL, { upstreamRelays: UPSTREAM_RELAYS });
        localRelayReady = true;
        await connectTo(LOCAL_RELAY_URL);
      } catch (error) {
        pushNotice(`ローカルリレーの起動に失敗しました: ${(error as Error).message}`);
      }
    })();
    return () => {
      connection.disconnect();
      handle?.stop();
    };
  });
</script>

<div class="app">
  <header class="app-header">
    <h1>Nostr Cache Web Client</h1>
    <p class="tagline">
      ブラウザ内キャッシュリレー ({LOCAL_RELAY_URL}) は
      {localRelayReady ? '稼働中' : '起動中…'}。
      対象URLへの接続はネットワークに出ずにローカルで処理されます。
    </p>
  </header>

  <ConnectionBar url={relayUrl} {status} onConnect={connectTo} onDisconnect={disconnect} />
  <FilterForm onSubmit={applyFilter} disabled={status !== 'connected'} />
  <PostForm onPost={post} disabled={status !== 'connected'} />

  {#if notices.length > 0}
    <ul class="notices">
      {#each notices as notice, index (index)}
        <li>{notice}</li>
      {/each}
    </ul>
  {/if}

  <Timeline {events} eose={eoseReceived} />
</div>
