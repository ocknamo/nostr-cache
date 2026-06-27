# Nostr Cache Relay

クライアント層で動く Nostr リレー実装本体です。NIP-01 に準拠したメッセージ処理
（`EVENT` / `REQ` / `CLOSE` → `OK` / `EVENT` / `EOSE` / `CLOSED` / `NOTICE`）を実装し、
kind 0 / 3 などの replaceable イベントにも対応します（NIP-02 のフォローリストは
この replaceable 処理の範囲でのみ扱われ、専用ロジックは持ちません）。
ストレージ（IndexedDB / Dexie.js）とトランスポート（WebSocket）をアダプタとして
差し替えることで、**Node.js サーバ**としても**ブラウザ内のローカルキャッシュリレー**としても
動作します。プロジェクト全体の目的は [../../doc/concept.md](../../doc/concept.md) を参照してください。

> **注意:** 開発中のパッケージです。`NostrRelayOptions` の一部（`maxEventsPerRequest`,
> `ttl`, 遅延バリデーション系）は型のみ定義されており
> 未実装です。詳細は [../../doc/TODO.md](../../doc/TODO.md) を参照してください。
>
> なお、ストレージ上限・退避（`storageMaxSize` / `cacheStrategy`）は `NostrRelayOptions`
> 経由ではなく**ストレージ層（`DexieStorage`）**で設定します（下記参照）。

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

### ブラウザ（ローカルキャッシュリレー）

```typescript
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay';

const storage = new DexieStorage('NostrCacheRelay');
const transport = new WebSocketServerEmulator();

const relay = new NostrCacheRelay(storage, transport, {
  validateEventsType: 'IMMEDIATELY',
  maxSubscriptions: 20,
});

// WebSocket をインターセプトして接続を開始
await relay.connect();
```

> **制約:** `WebSocketServerEmulator` は**特定の1つの URL に一致する接続のみ**を
> インターセプトします。現状 `connect()` はインターセプト対象 URL を `start()` へ
> 渡さないため、既定の `ws://localhost:3000` 宛ての接続だけが対象になります。
> 任意のリレー URL を横取りする用途にはまだ対応していません。

### Node.js（サーバとして起動）

```typescript
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServer,
} from '@nostr-cache/cache-relay';
import 'fake-indexeddb/auto'; // Node.js で IndexedDB をエミュレート

const storage = new DexieStorage('NostrRelay');
const transport = new WebSocketServer(8008);

const relay = new NostrCacheRelay(storage, transport, {
  maxSubscriptions: 100,
});

await relay.connect();
```

> すぐに使えるサーバ実装は `@nostr-cache/server` パッケージにもあります。

### ストレージ上限と退避（eviction）

保存件数の上限と退避戦略は `DexieStorage` のコンストラクタオプションで設定します。
上限を超えると、保存のたびに古いイベント（`created_at` 昇順）から退避されます。

```typescript
const storage = new DexieStorage('NostrCacheRelay', {
  maxSize: 10000, // この件数を超えると古いものから退避（未指定で無制限）
  cacheStrategy: 'FIFO', // 現状 FIFO のみ実装。LRU/LFU は FIFO にフォールバック
});
```

`@nostr-cache/server` では `storageOptions.maxSize` / `storageOptions.cacheStrategy`
で同じ設定を渡せます。

### ローカル API による購読 / 発行

トランスポート越しのクライアントとは別に、同一プロセス内から直接購読・発行できます。

```typescript
relay.on('event', (event) => console.log('event', event));
relay.on('eose', (subscriptionId) => console.log('eose', subscriptionId));

// 保存済みイベントを再生し、最後に eose を発火
await relay.subscribe('sub1', [{ kinds: [1], limit: 50 }]);

// 発行。ローカル購読にマッチすれば 'event' が発火する
await relay.publishEvent(event);

relay.unsubscribe('sub1');
```

## API

### `new NostrCacheRelay(storage, transport, options?)`

- `storage: StorageAdapter` — 例: `new DexieStorage(dbName)`
- `transport: TransportAdapter` — 例: `new WebSocketServer(port)` / `new WebSocketServerEmulator()`
- `options?: NostrRelayOptions`

### メソッド

- `connect(): Promise<void>` — トランスポートを開始し `connect` を発火。
- `disconnect(): Promise<void>` — トランスポートを停止し `disconnect` を発火。
- `publishEvent(event: NostrEvent): Promise<boolean>` — イベントを検証・保存し、
  マッチするローカル購読へ `event` を通知。保存成否を返す。
- `subscribe(subscriptionId: string, filters: Filter[]): Promise<void>` — ローカル購読を
  登録し、保存済みの一致イベントを `event` で再生後、`eose` を発火。
- `unsubscribe(subscriptionId: string): boolean` — ローカル購読を削除。削除できれば `true`。
- `on(event, callback)` / `off(event, callback)` — イベントリスナの登録・解除。
  イベント種別: `'connect' | 'disconnect' | 'error' | 'event' | 'eose'`。

### `NostrRelayOptions`

| オプション | 型 | 状況 |
|---|---|---|
| `maxSubscriptions` | `number` | 実装済み（デフォルト 20） |
| `validateEventsType` | `'NONE' \| 'IMMEDIATELY' \| 'LAZY'` | 一部実装。`LAZY` は未実装。**注意:** この設定が効くのは in-process の `publishEvent()` のみ。トランスポート経由（`EVENT` メッセージ）の検証は本設定に関わらず常に実行されるため、`NONE` でもリレー入口の検証は無効化されない |
| `port` | `number` | Node.js の WebSocket サーバ用 |
| `maxEventsPerRequest` | `number` | **未実装** |
| `storageMaxSize` | `number` | `NostrRelayOptions` 経由は未配線。退避はストレージ層（`DexieStorage`）の `maxSize` で設定（下記） |
| `ttl` | `number` | **未実装** |
| `cacheStrategy` | `'LRU' \| 'FIFO' \| 'LFU'` | `NostrRelayOptions` 経由は未配線。`DexieStorage` の `cacheStrategy` で設定。現状 `FIFO` のみ実装（`LRU`/`LFU` は FIFO にフォールバック・警告） |
| `lazyValidateInterval` | `number` | **未実装** |
| `lazyValidateBachSize` | `number` | **未実装**（`Batch` のタイポ。リネームは破壊的変更のため留意） |

詳細・最新の状況は [../../doc/TODO.md](../../doc/TODO.md) を参照してください。
