# Nostr Cache Relay

クライアント層で動く Nostr リレー実装本体。ストレージ（IndexedDB / Dexie.js）と
トランスポート（WebSocket）をアダプタとして差し替えることで、**Node.js サーバ**としても
**ブラウザ内のローカルキャッシュリレー**としても動作します。

- プロジェクト全体の目的: [doc/concept.md](../../doc/concept.md)
- 公開 API・オプション・対応 NIP の適用ルール: [doc/api.md](../../doc/api.md)
- 実装状況と既知の制約: [doc/TODO.md](../../doc/TODO.md)
- 内部設計: [doc/cache-relay/](../../doc/cache-relay/)

## 構成要素

`NostrCacheRelay` は次の 2 つのアダプタを受け取って動作します。

- **StorageAdapter** … イベントの永続化。`DexieStorage`（IndexedDB / Dexie.js）を提供。
  テスト・サーバ環境では `fake-indexeddb` でエミュレートします。
- **TransportAdapter** … クライアントとの通信。
  - `WebSocketServer` … Node.js 用（`ws` ベース）。
  - `WebSocketServerEmulator` … ブラウザ用。`globalThis.WebSocket` をインターセプトします。

## インストール

```bash
npm install @nostr-cache/cache-relay
```

## 使用方法

### ブラウザ

ブラウザからキャッシュとして使う方法は 2 つあります。

**① 透過型: `WebSocketServerEmulator` で WebSocket を横取り**

既存の Nostr クライアント実装（素の `WebSocket` で NIP-01 を話すもの）を変更せずに、
対象 URL への接続をブラウザ内リレーへ差し替えます。組み立て手順・対象 URL の指定パターン・
注意点は [doc/transparent-cache.md](../../doc/transparent-cache.md) にまとめてあります。

```typescript
// ブラウザでは Node.js 専用 WebSocketServer を含まない /browser エントリを使う
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';

const relay = new NostrCacheRelay(
  new DexieStorage('NostrCacheRelay'),
  new WebSocketServerEmulator(),
);

await relay.connect(); // ここで globalThis.WebSocket が差し替わる

// 以降、クライアントは普通に接続するだけでローカルリレーに繋がる
const ws = new WebSocket('ws://nostr-cache.invalid');
```

**② 直接型: `NostrCacheRelay` の in-process API を呼ぶ**

WebSocket を介さず、リレーをライブラリとして直接使うこともできます
（自前クライアントを新規に書く場合はこちらが最短）。エミュレータは不要で、
①と同様に組み立てた `relay`（transport は使われない）にリスナを登録して使います。

```typescript
relay.on('event', (event) => console.log('event:', event.content));
relay.on('eose', (subscriptionId) => console.log('eose:', subscriptionId));

await relay.publishEvent(event);                  // 保存（既定では署名検証込み）
await relay.subscribe('sub-1', [{ kinds: [1] }]); // 保存済みイベントを再生し eose を発火
relay.unsubscribe('sub-1');
```

> in-process 経路は `EventHandler` を経由しないため、replaceable の版比較・置換が
> 効きません（[doc/TODO.md](../../doc/TODO.md) の「API の一貫性」）。

### Node.js（サーバとして起動）

```typescript
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServer,
} from '@nostr-cache/cache-relay';
import 'fake-indexeddb/auto'; // Node.js で IndexedDB をエミュレート

const relay = new NostrCacheRelay(
  new DexieStorage('NostrRelay'),
  new WebSocketServer(8008),
  { maxSubscriptions: 100 },
);

await relay.connect();
```

> すぐに使えるサーバ実装は [`@nostr-cache/server`](../server/README.md) にもあります。

## キャッシュとしての設定

どちらの形態も既定では「ローカルに保存済みのイベントを返す独立リレー」です。
`NostrRelayOptions` で次の 3 つの軸を設定します（**各オプションの意味・既定値・制約は
[doc/api.md](../../doc/api.md#interface-nostrrelayoptions) が唯一の情報源**です）。

| 軸 | オプション |
|---|---|
| 保存量の制御 | `storageMaxSize` / `cacheStrategy` / `ttl` / `cachePriority` |
| 上流への透過キャッシュ化 | `upstreamRelays` / `upstreamEoseTimeout` / `upstreamFreshness` |
| 署名検証 | `validateEventsType` / `lazyValidateInterval` / `lazyValidateBatchSize` |

```typescript
const relay = new NostrCacheRelay(storage, transport, {
  storageMaxSize: 10000,       // 超過分は cacheStrategy に従って退避
  ttl: 3600,
  cachePriority: {
    pubkeys: ['npub1...'],     // 自分の投稿は最後まで残す
    kinds: [0],                // プロフィールは TL 描画で大量参照されるため優先
  },
  upstreamRelays: ['wss://nos.lol'],
  upstreamFreshness: { 0: 3600 }, // 1時間以内にキャッシュした kind 0 は上流に聞かない
});

// 優先設定は実行時にも差し替えられる（例: ログインユーザの切り替えに追従）
relay.setCachePriority({ pubkeys: [currentUserNpub], kinds: [0] });
```

上流キャッシュの設計（リードスルー / ライトスルー・鮮度ウィンドウ・id カバレッジ短絡）は
[doc/cache-relay/upstream.md](../../doc/cache-relay/upstream.md) を参照してください。
