# API リファレンス / API Reference

このドキュメントは `nostr-cache` モノレポが公開する主要 API をまとめたものです。
対応する実行可能なサンプルは [`examples/`](../examples/README.md) を参照してください。

This document summarizes the primary public API exposed by the `nostr-cache`
monorepo. Runnable samples live in [`examples/`](../examples/README.md).

> 対象バージョン: `main` ブランチ時点 / Reflects the state of the `main` branch.

## パッケージ構成 / Packages

| パッケージ / Package | 役割 / Role |
|---|---|
| `@nostr-cache/shared` | 共有型・ユーティリティ / Shared types & utilities |
| `@nostr-cache/cache-relay` | リレー本体（ブラウザ / Node.js）/ Relay core (browser & Node.js) |
| `@nostr-cache/server` | Node.js リレーサーバー / Node.js relay server |

---

## `@nostr-cache/cache-relay`

リレー本体です。ストレージ（`StorageAdapter`）とトランスポート（`TransportAdapter`）を
受け取り、NIP-01 のメッセージ処理・購読管理・イベント検証を行います。

The relay core. It takes a `StorageAdapter` and a `TransportAdapter` and handles
NIP-01 message processing, subscription management, and event validation.

#### 対応 NIP / Supported NIPs

- **NIP-01**: 基本のイベント・メッセージ・フィルタ / core events, messages, filters
- **NIP-02**: kind 3（フォローリスト）を置換可能イベントとして扱う / kind 3 treated as replaceable
- **NIP-09**: 削除リクエスト（kind 5）。詳細は下記 / deletion requests (kind 5), see below

##### NIP-09（イベント削除リクエスト） / Event deletion requests

kind 5 のイベントを受け取ると、リレーは `e` タグ（イベント id）と `a` タグ
（`<kind>:<pubkey>:<d-identifier>` 座標）が指す先を削除します。適用ルール:

- **同一 `pubkey` のイベントのみ削除**します。他者のイベントを指す参照は無視されます
- **削除リクエスト自体は保存し、配信し続けます**（まだ受け取っていないクライアントのため）。
  kind 5 を指す kind 5 は効果を持ちません
- `a` タグは `created_at <= 削除リクエストの created_at` の版のみを削除します。
  リクエストより後に公開された版は残ります
- `a` タグは置換可能 kind（0 / 3 / 10000–19999）とアドレサブル kind（30000–39999）にのみ
  適用します。`1:<pubkey>:` のような通常 kind の座標は無視します
  （1 つのタグが「この著者の kind 1 を全削除」になるのを防ぐため）
- 削除は取り消せないため、`validateEventsType: 'LAZY'` でも kind 5 は**同期的に署名検証**します
- 上流リレーから流れてきた kind 5 にも同じ処理を適用します（透過キャッシュ経路）

When a kind 5 event arrives the relay deletes the events referenced by its `e`
tags (event ids) and `a` tags (`<kind>:<pubkey>:<d-identifier>` coordinates):
only the request author's own events are deleted; the request itself is stored
and kept served indefinitely (and a kind 5 targeting a kind 5 has no effect);
`a` tags delete only versions with `created_at <= ` the request's `created_at`,
and only for replaceable / addressable kinds. Because deletion cannot be undone,
kind 5 signatures are verified synchronously even in `LAZY` mode, and the same
handling applies to kind 5 events ingested from upstream relays.

現状の制約 / Known limitation: 削除済みイベントの「復活」防止は未実装です。削除リクエストを
受け取った後に、同じイベントが別経路（削除を反映していない上流リレー、クライアントの再送）
から再び届いた場合は再び保存されます。/ Resurrection is not prevented: if a deleted event
arrives again from another source (an upstream relay that has not honored the deletion, a
client rebroadcast), it is stored again.

### `class NostrCacheRelay`

```typescript
import {
  NostrCacheRelay,
  DexieStorage,
  WebSocketServer,
} from '@nostr-cache/cache-relay';

const storage = new DexieStorage('MyRelay');     // StorageAdapter
const transport = new WebSocketServer(8008);      // TransportAdapter
const relay = new NostrCacheRelay(storage, transport, {
  maxSubscriptions: 20,
  validateEventsType: 'IMMEDIATELY',
});

await relay.connect();
// ...
await relay.disconnect();
```

#### コンストラクタ / Constructor

```typescript
new NostrCacheRelay(
  storage: StorageAdapter,
  transport: TransportAdapter,
  options?: NostrRelayOptions,
)
```

#### メソッド / Methods

| メソッド / Method | 説明 / Description |
|---|---|
| `connect(): Promise<void>` | トランスポートを起動し `connect` イベントを発火 / Starts the transport and emits `connect` |
| `disconnect(): Promise<void>` | トランスポートを停止し `disconnect` イベントを発火 / Stops the transport and emits `disconnect` |
| `publishEvent(event: NostrEvent): Promise<boolean>` | イベントを検証・保存し、一致するローカル購読へ `event` を通知。kind 5 は保存後に NIP-09 の削除を適用。保存成功で `true` / Validates, stores, and notifies matching local subscriptions; a kind 5 event also applies its NIP-09 deletion after being stored. Resolves `true` on success |
| `subscribe(subscriptionId: string, filters: Filter[]): Promise<void>` | インプロセス購読を作成し、保存済みイベントを `event` リスナへ再生してから `eose` を発火 / Creates an in-process subscription, replays stored events to `event` listeners, then emits `eose` |
| `unsubscribe(subscriptionId: string): boolean` | 購読を削除。存在して削除できたら `true` / Removes a subscription; `true` if it existed |
| `getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>>` | イベント id ごとの永続化された署名検証状態（`'validated'` / `'pending'` / `'unknown'`）を一括取得。主キー参照のため高頻度呼び出し可・LRU/LFU のアクセス追跡に影響しない。組み込みクライアントが自前の署名検証を省略してバッジ表示等に使える / Bulk-fetches the persisted signature-verification status per event id. Primary-key lookup — cheap to poll and never counts as a read for LRU/LFU. Lets an embedding client reuse the relay's verification instead of re-verifying |
| `setCachePriority(input?): void` | キャッシュ優先度設定（`cachePriority` オプションと同形式。pubkey は npub / hex 可）を実行時に差し替える。不正値は例外を投げて現行設定を維持。`undefined` で解除。優先判定は退避・TTL スイープ実行時に評価されるため、次回の退避・スイープから即反映（退避済みイベントは戻らない） / Replaces the cache priority config at runtime (same shape as the `cachePriority` option; pubkeys as npub or hex). Invalid input throws and keeps the current config; pass `undefined` to clear. Priority is evaluated at eviction / TTL-sweep time, so new rules apply from the next pass — already-evicted events are not restored |
| `on(event, callback): void` | イベントリスナを登録 / Registers an event listener |
| `off(event, callback): void` | イベントリスナを解除 / Removes an event listener |

#### イベント / Events

`on()` / `off()` で購読できるイベント:

| イベント / Event | コールバック引数 / Callback argument |
|---|---|
| `connect` | なし / none |
| `disconnect` | なし / none |
| `error` | `Error` |
| `event` | `NostrEvent` |
| `eose` | `subscriptionId: string` |

> 既知の制約 / Known limitation: `event` 通知は `subscriptionId` を伴いません。複数の
> ローカル購読を同時に使う場合、どの購読由来かを区別できません（`doc/TODO.md` 参照）。
> The `event` notification does not carry the `subscriptionId`, so multiple
> simultaneous local subscriptions cannot be distinguished.

### `interface NostrRelayOptions`

```typescript
interface NostrRelayOptions {
  maxSubscriptions?: number;        // クライアントあたりの最大購読数 (default: 20)
  maxEventsPerRequest?: number;     // REQ 応答 / subscribe 再生で返す最大件数 (default: 500)。超過時は新しい順に N 件
  storageMaxSize?: number;          // 最大保存件数。超過時は relay が storage.enforceLimit を呼び cacheStrategy に従って退避（未指定で無効）
  ttl?: number;                     // TTL 秒。キャッシュ投入（保存）からの経過時間が超過したイベントを定期スイープで削除
                                    // （created_at 基準ではない。未指定で無効。deleteExpired 対応ストレージが必要）
  ttlSweepInterval?: number;        // TTL スイープの実行間隔 秒 (default: 60)
  cacheStrategy?: 'LRU' | 'FIFO' | 'LFU'; // 退避戦略 (default: 'FIFO')。FIFO=作成が古い順 / LRU=読み出しが古い順 / LFU=読み出し頻度が低い順（同数なら古い順）
                                    // ※ 挿入も1回のアクセスとして数える。置換可能イベントは上書きのたびに
                                    //    アクセス履歴がリセットされるため、頻繁に更新されるものは LFU で不利になる
  cachePriority?: {                 // キャッシュ優先度。指定 pubkey（npub / hex 可）の発行イベント、または指定 kind の
    pubkeys?: string[];             // イベントを「優先イベント」として扱う。優先イベントは storageMaxSize 超過時に
    kinds?: number[];               // 最後まで残り（非優先を先に退避。優先だけになったら通常の cacheStrategy 順で退避し
  };                                // maxSize は常に厳守）、TTL スイープの削除対象外。不正な npub は生成時に例外
  validateEventsType?: 'NONE' | 'IMMEDIATELY' | 'LAZY'; // 検証方式 (default: 'IMMEDIATELY')
                                    // 'IMMEDIATELY'=同期検証, 'NONE'=検証なし,
                                    // 'LAZY'=受理・保存後にバックグラウンド検証し不正を削除（in-process / transport 両経路）
                                    //         検証キューはストレージ自体（validated カラム）に永続化され、
                                    //         リロード/クラッシュ後も次回 connect() 時に検証を自動再開する
                                    //         ※ ephemeral 等の未保存イベントは LAZY でも同期検証して即拒否
                                    // 検証結果は IMMEDIATELY=検証済み / NONE・LAZY=未検証として保存され、
                                    // getValidationStatus() で参照できる（LAZY は検証後に検証済みへ更新）
  lazyValidateInterval?: number;    // LAZY のバックグラウンド検証間隔 秒 (default: 60)
  lazyValidateBatchSize?: number;   // LAZY の1回あたり検証件数 (default: 100)
  port?: number;                    // WebSocket ポート (Node.js)
  upstreamRelays?: string[];        // 上流実リレー URL。指定時のみリード/ライトスルー有効（未指定で独立リレー）
  upstreamEoseTimeout?: number;     // 上流 EOSE を待ってクライアントへ EOSE を返す上限 ms (default: 3000)
  upstreamConnectionTimeout?: number; // 上流への接続タイムアウト ms (default: 5000)
  upstreamPool?: UpstreamPool;      // テスト・高度用途: 上流プール実装の差し替え（upstreamRelays より優先）
}
```

> `※未実装` の項目は型としては存在しますが、現状フルにはサポートされていません。
> Options marked `※未実装` exist in the type but are not fully implemented yet.

`upstreamRelays` を指定すると、リレーは上流実リレー群の手前に挟まる透過キャッシュとして
動作します（リードスルー / ライトスルー）。関連クラス `UpstreamRelayPool` /
`UpstreamConnection` / `UpstreamCoordinator` と型 `UpstreamPool` / `UpstreamPoolOptions` が
`@nostr-cache/cache-relay`（および `/browser`）から公開されています。設計は
[doc/cache-relay/upstream.md](./cache-relay/upstream.md) を参照してください。

### `interface StorageAdapter`

イベントの保存を担う抽象。`DexieStorage`（IndexedDB / fake-indexeddb）が標準実装です。
このほか `@nostr-cache/server` 内には Node.js 専用の永続実装 `SqliteStorage`
（`node:sqlite` エンジン + Drizzle ORM のクエリ層。`storageOptions.dbPath` で有効化）が
あります。

```typescript
type ValidationStatus = 'validated' | 'pending' | 'unknown';

interface StorageAdapter {
  saveEvent(event: NostrEvent, options?: { validated?: boolean }): Promise<boolean>;
  getEvents(filters: Filter[]): Promise<NostrEvent[]>;
  deleteEvent(id: string): Promise<boolean>;
  clear(): Promise<void>;
  count(): Promise<number>;
  deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean>;
  deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string,
  ): Promise<boolean>;
  deleteEventsByIdsForPubkey(ids: string[], pubkey: string): Promise<number>;
  deleteEventsByAddress(address: EventAddress, until: number): Promise<number>;
  getUnvalidatedEvents(limit: number): Promise<NostrEvent[]>;
  markValidated(ids: string[]): Promise<void>;
  getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>>;
}

interface EventAddress {
  kind: number;       // 対象の kind / kind of the addressed event
  pubkey: string;     // 64 桁 hex / 64-char lowercase hex
  identifier: string; // `d` タグ値（置換可能 kind では空） / `d` tag value (empty for replaceable kinds)
}
```

- `saveEvent` の `options.validated`（省略時 `false`）で検証済みとして保存できます。既存行が
  検証済みの場合、再保存しても未検証へはダウングレードされません（同一 id = 同一内容のため）。
  / `options.validated` (default `false`) stores the event as verified. Re-saving never
  downgrades an already-verified row (same id = same content hash).
- `getUnvalidatedEvents` は未検証イベントを保存時刻の古い順に返します。遅延検証の
  永続キューであり、リロード後の検証再開を支えます。
  / Returns unvalidated events oldest-first — the persistent lazy-validation queue.
- `getValidationStatus` は id ごとに `'validated'` / `'pending'` / `'unknown'`（未保存・削除済み）を
  返します。これらの読み取りは LRU/LFU のアクセス追跡に影響しません。
  / Per-id status lookup; these reads never affect LRU/LFU access tracking.
- `deleteEventsByIdsForPubkey` / `deleteEventsByAddress` は NIP-09（削除リクエスト）の
  `e` タグ / `a` タグに対応します。実装側で 2 つの制約を保証する必要があります
  （呼び出し側は保存済みの行を見られないため）: **`pubkey` が一致するイベントのみ削除する**、
  **kind 5 は決して削除しない**（削除リクエストに対する削除リクエストは効果を持たない）。
  `deleteEventsByAddress` は `created_at <= until` の版のみを削除し、アドレサブル kind
  （30000–39999）では `d` タグが `address.identifier` と一致する必要があります（`d` タグが
  無い場合は空文字列とみなします）。置換可能 kind では `identifier` は無視されます。
  / Back the `e` / `a` tags of a NIP-09 deletion request. Implementations must enforce
  both spec rules themselves — delete only events with a matching `pubkey`, and never
  delete a kind 5 event. `deleteEventsByAddress` deletes only versions with
  `created_at <= until`; for addressable kinds the `d` tag must equal
  `address.identifier` (a missing `d` tag counts as the empty identifier), while for
  replaceable kinds the identifier is ignored.
- `getEvents` のフィルタ解釈は NIP-01 準拠で、`DexieStorage` と `SqliteStorage` で一致します。
  - `since` / `until` はいずれも境界を含みます（`since <= created_at <= until`）。`0` も
    「指定なし」ではなく実際の境界として扱います。
  - `filter.limit` は「一致するイベントのうち**最新** N 件」を返し、**新しい順**
    （`created_at` 降順、同値は id の昇順でタイブレーク）に並びます。一致件数が `limit` 以下でも
    並び順は同じです。`limit` はフィルタごとに適用され、複数フィルタの結果は id で
    重複排除されます（複数フィルタをまたいだ順序は保証しません）。
  - `limit` を指定しない場合の並び順は未規定です（ストレージの走査順のまま返ります）。
  - `limit` は非負整数へ正規化されます（小数は切り捨て、負値は 0、`NaN` / `Infinity` は
    「クライアント指定なし」として無視）。
  / Filter semantics follow NIP-01 and match across both implementations: `since`/`until` are
  inclusive bounds (`0` included — it is a real bound, not "unset"); `filter.limit` returns the
  **newest** N matches, ordered newest-first (`created_at` desc, id asc as tiebreak) even when
  fewer events match than the limit. `limit` applies per filter and is normalized to a
  non-negative integer; results across filters are deduplicated by id (order across filters is
  not guaranteed). Without `limit` the ordering is unspecified.

### `interface TransportAdapter`

クライアントとの通信を担う抽象。Node.js 向け `WebSocketServer` と、ブラウザ向けに
`WebSocket` を横取りする `WebSocketServerEmulator` が提供されます。
`WebSocketServerEmulator` はコンストラクタでインターセプト対象 URL（単数または配列、
既定 `ws://nostr-cache.invalid`）を受け取り、対象 URL への接続を実ネットワークに触れずに
エミュレートします（複数同時接続対応）。対象外 URL は元の `WebSocket` に委譲されます。

```typescript
interface TransportAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(clientId: string, message: NostrWireMessage): void;
  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void;
  onConnect(callback: (clientId: string) => void): void;
  onDisconnect(callback: (clientId: string) => void): void;
  getConnectionCount(): number;
}
```

---

## `@nostr-cache/server`

`@nostr-cache/cache-relay` を `WebSocketServer` と組み立てた、すぐ起動できる
Node.js リレーサーバーです。ストレージは既定で `DexieStorage`（fake-indexeddb・
インメモリ）、`storageOptions.dbPath`（または環境変数 `NOSTR_DB_PATH`）を指定すると
`node:sqlite` による永続ストレージ（`SqliteStorage`）にオプトインできます。

A ready-to-run Node.js relay server that wires `@nostr-cache/cache-relay` with
`WebSocketServer`. Storage defaults to `DexieStorage` (fake-indexeddb, in-memory);
setting `storageOptions.dbPath` (or the `NOSTR_DB_PATH` env var) opts in to the
durable `node:sqlite` backend (`SqliteStorage`).

### `class NostrRelayServer`

```typescript
import { NostrRelayServer } from '@nostr-cache/server';

const server = new NostrRelayServer({
  port: 8008,
  relay: { maxSubscriptions: 200 },
});

await server.start();
// ...
await server.stop();
```

`relay.upstreamRelays`（+ `upstreamEoseTimeout` / `upstreamConnectionTimeout`）を
指定すると、このサーバーは上流実リレー群の手前に挟まる透過キャッシュ（リード/ライト
スルー）として動作します。

```typescript
const cache = new NostrRelayServer({
  port: 8008,
  relay: { upstreamRelays: ['wss://nos.lol'] },
});
```

| メソッド / Method | 説明 / Description |
|---|---|
| `start(): Promise<void>` | サーバーを起動 / Starts the server |
| `stop(): Promise<void>` | サーバーを停止。既定モードではストレージをクリア、永続モード（`dbPath` 指定時）ではデータを保持したまま DB を閉じる / Stops the server; clears storage in the default mode, keeps data and closes the DB in persistent mode (`dbPath`) |
| `getConnectionCount(): number` | 現在の WebSocket 接続数 / Current WebSocket connection count |
| `getEventCount(): Promise<number>` | 保存済みイベント数 / Number of stored events |
| `getPort(): number` | 待ち受けポート / The configured port |
| `setCachePriority(input?): void` | キャッシュ優先度設定（`storageOptions.cachePriority` と同形式。npub / hex 可）を実行時に差し替える。不正値は例外で現行設定を維持、`undefined` で解除。次回の退避・TTL スイープから反映 / Replaces the cache priority config at runtime (same shape as `storageOptions.cachePriority`; npub or hex). Invalid input throws and keeps the current config; `undefined` clears. Applies from the next eviction / TTL sweep |

設定オプションの詳細は [`packages/server/README.md`](../packages/server/README.md) を参照してください。
See the server README for the full option list.

---

## `@nostr-cache/shared`

### 主要な型 / Key types

```typescript
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}
```

### ワイヤーフォーマット / Wire format (NIP-01)

WebSocket 上でやり取りされる配列形式のメッセージ:

```typescript
type NostrWireMessage =
  | ['EVENT', NostrEvent]
  | ['EVENT', string, NostrEvent]      // subscriptionId 付き / with subscriptionId
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string]
  | ['OK', string, boolean, string?]
  | ['EOSE', string]
  | ['CLOSED', string, string?]
  | ['NOTICE', string];
```

### ユーティリティ / Utilities

| エクスポート / Export | 説明 / Description |
|---|---|
| `logger`, `LogLevel` | ロガー / Logger |
| `getRandomSecret()` | 32 バイトのランダム秘密鍵（hex）/ Random 32-byte secret key (hex) |
| `messageToWire(message)` | 内部メッセージ型をワイヤー配列へ変換 / Converts an internal message into the wire array form |

---

## サンプルコード / Sample code

リポジトリルートから実行できる E2E デモを用意しています。

A runnable end-to-end demo is available from the repository root:

```bash
npm run build
node examples/node-relay-demo.mjs
```

詳細は [`examples/README.md`](../examples/README.md) を参照してください。
See [`examples/README.md`](../examples/README.md) for details.
