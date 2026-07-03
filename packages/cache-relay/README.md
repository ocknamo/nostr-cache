# Nostr Cache Relay

クライアント層で動く Nostr リレー実装本体です。NIP-01 に準拠したメッセージ処理
（`EVENT` / `REQ` / `CLOSE` → `OK` / `EVENT` / `EOSE` / `CLOSED` / `NOTICE`）を実装し、
kind 0 / 3 などの replaceable イベントにも対応します（NIP-02 のフォローリストは
この replaceable 処理の範囲でのみ扱われ、専用ロジックは持ちません）。
ストレージ（IndexedDB / Dexie.js）とトランスポート（WebSocket）をアダプタとして
差し替えることで、**Node.js サーバ**としても**ブラウザ内のローカルキャッシュリレー**としても
動作します。プロジェクト全体の目的は [../../doc/concept.md](../../doc/concept.md) を参照してください。

> **注意:** 開発中のパッケージです。`cacheStrategy` の `LRU` / `LFU` は未実装で、
> 指定しても `FIFO` にフォールバックします。詳細は [../../doc/TODO.md](../../doc/TODO.md) を参照してください。

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

ブラウザからキャッシュとして使う方法は2つあります。

**① 透過型: `WebSocketServerEmulator` で WebSocket を横取り**

既存の Nostr クライアント実装（素の `WebSocket` で NIP-01 を話すもの）を変更せずに、
対象 URL への接続をブラウザ内リレーへ差し替えます。

```typescript
// ブラウザでは Node.js 専用 WebSocketServer を含まない /browser エントリを使う
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';

const storage = new DexieStorage('NostrCacheRelay');
const transport = new WebSocketServerEmulator();

const relay = new NostrCacheRelay(storage, transport, {
  validateEventsType: 'IMMEDIATELY',
  maxSubscriptions: 20,
});

// WebSocket をインターセプトして接続を開始
await relay.connect();

// 以降、クライアントは普通に接続するだけでローカルリレーに繋がる
const ws = new WebSocket('ws://nostr-cache.invalid');
```

> インターセプト対象 URL はコンストラクタで指定できます
> （例: `new WebSocketServerEmulator(['wss://relay.example.com/', 'ws://nostr-cache.invalid'])`）。
> 省略時は `ws://nostr-cache.invalid`。既定値に RFC 6761 予約 TLD の `.invalid` を
> 使っているのは、エミュレータが動いていない場合でも実在するサーバーへ誤接続する
> 可能性をゼロにするためです（`ws://localhost:3000` のような「ありえる」URL は使わない）。
> 対象 URL への接続は実ネットワークに一切触れず、複数の同時接続をそれぞれ独立した
> クライアントとして扱います。対象外の URL への接続は元の `WebSocket` にそのまま
> 委譲されます。

**② 直接型: `NostrCacheRelay` の in-process API を呼ぶ**

WebSocket を介さず、リレーをライブラリとして直接使うこともできます
（自前クライアントを新規に書く場合はこちらが最短）。エミュレータは不要で、
①と同様に組み立てた `relay`（transport は使われない）に対してリスナを登録して使います。

```typescript
// 購読結果・ライブ配信は 'event' / 'eose' リスナに届く
relay.on('event', (event) => console.log('event:', event.content));
relay.on('eose', (subscriptionId) => console.log('eose:', subscriptionId));

await relay.publishEvent(event); // 保存 (既定の validateEventsType: 'IMMEDIATELY' では検証込み)
await relay.subscribe('sub-1', [{ kinds: [1] }]); // 保存済みイベントをリスナへ再生し eose を発火
relay.unsubscribe('sub-1');
```

現状はどちらの形態も「ローカルに保存済みのイベントを返す独立リレー」であり、
上流リレーへのリードスルー / ライトスルー（透過キャッシュ化）は未実装です
（[doc/TODO.md](../../doc/TODO.md) 参照）。

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

保存件数の上限と退避戦略は `NostrRelayOptions` の `storageMaxSize` / `cacheStrategy`
で設定します。上限を超えると、relay が保存後に `storage.enforceLimit()` を呼び、
古いイベント（`created_at` 昇順）から退避します。

```typescript
const relay = new NostrCacheRelay(storage, transport, {
  storageMaxSize: 10000, // この件数を超えると古いものから退避（未指定で無制限）
  cacheStrategy: 'FIFO', // 現状 FIFO のみ実装。LRU/LFU は FIFO にフォールバック
});
```

`@nostr-cache/server` では `storageOptions.maxSize` / `storageOptions.cacheStrategy`
で同じ設定を渡せます。退避には `enforceLimit` を実装したストレージ（`DexieStorage`）が必要です。

> **注意:** 上限は**ソフトリミット**です。退避パス（件数確認＋削除）はトランザクション
> で原子化していますが、`saveEvent` 自体は別コミットのため、並行書き込み下では一時的に
> `maxSize` を超えることがあります（最終的に収束）。また FIFO は `created_at`（秒精度）
> 基準で、同値のイベントは主キー（id）順で退避されます（厳密な到着順ではない近似）。

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
| `validateEventsType` | `'NONE' \| 'IMMEDIATELY' \| 'LAZY'` | 実装済み（デフォルト `IMMEDIATELY`）。in-process `publishEvent()` とトランスポート経由 `EVENT` の**両方**に適用。`IMMEDIATELY`=同期検証して不正を拒否、`NONE`=検証しない、`LAZY`=保存・受理して即応答し、バックグラウンドでバッチ検証して不正をストレージから削除。`LAZY` では保存されたイベントが最大 `lazyValidateInterval` 秒ぶん一時的に未検証で配信され得る。なお **ephemeral（kind 20000–29999）など保存されないイベントは、後から削除できないため `LAZY` でも同期検証**して不正を即拒否する |
| `port` | `number` | Node.js の WebSocket サーバ用 |
| `maxEventsPerRequest` | `number` | 実装済み（デフォルト 500）。REQ 応答 / `subscribe()` 再生で返すストレージイベント数の上限。各フィルタの `limit` の上にかぶせるキャップで、超過時は新しい順に N 件を残す |
| `storageMaxSize` | `number` | 実装済み。保存後に relay が `storage.enforceLimit()` を呼び、この件数を超えたら古い順に退避（未指定で無効。`enforceLimit` 対応ストレージが必要） |
| `ttl` | `number` | 実装済み。キャッシュ投入（保存）時刻 `cached_at` が `now - ttl` より古いイベントを**バックグラウンドの定期スイープ**でストレージから削除（`created_at` 基準ではなく、読み出し時フィルタでもない）。最大で `ttlSweepInterval` 秒ぶん期限切れイベントを返しうる。未指定で無効。`deleteExpired` 対応ストレージ（`DexieStorage`）が必要 |
| `ttlSweepInterval` | `number` | 実装済み。TTL スイープの実行間隔（秒、デフォルト 60） |
| `cacheStrategy` | `'LRU' \| 'FIFO' \| 'LFU'` | 実装済み（`storageMaxSize` の退避戦略、デフォルト `FIFO`）。`FIFO`=作成が古い順、`LRU`=読み出しが古い順、`LFU`=読み出し頻度が低い順（同数なら古い順） |
| `lazyValidateInterval` | `number` | 実装済み。`LAZY` 時のバックグラウンド検証の実行間隔（秒、デフォルト 60） |
| `lazyValidateBatchSize` | `number` | 実装済み。`LAZY` 時の 1 回の検証で処理するイベント数（デフォルト 100） |

詳細・最新の状況は [../../doc/TODO.md](../../doc/TODO.md) を参照してください。
