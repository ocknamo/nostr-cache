# Nostr Cache Server

`@nostr-cache/cache-relay` を `WebSocketServer` と組み立てた、すぐ起動できる Node.js
リレーサーバー。リレーとしての振る舞い（対応 NIP・イベント検証・購読管理・退避と TTL）は
すべてリレーコアのもので、[doc/api.md](../../doc/api.md) が唯一の情報源です。
このパッケージが固有に持つのは、**起動方法・永続化・環境変数・ヘルスチェック**です。

## インストールと実行

ルートディレクトリから以下のコマンドを実行してください：

```bash
# サーバーパッケージをビルド
npm run build:server

# 開発モードでサーバーを起動
npm run dev:server

# 本番モードでサーバーを起動
npm run start:server
```

サーバーはデフォルトで 8008 ポートで起動します。WebSocket クライアントを使用して
接続できます。

## 永続化（オプトイン）

既定ではストレージは fake-indexedDB（インメモリ）で動作し、**プロセス終了で全イベントが
失われます**。環境変数 `NOSTR_DB_PATH` に SQLite データベースのファイルパスを指定すると、
Node.js 組み込みの `node:sqlite` による永続ストレージにオプトインでき、再起動をまたいで
イベントが保持されます（親ディレクトリは自動作成されます）。

```bash
# 永続化を有効にして起動
NOSTR_DB_PATH=/var/lib/nostr-cache/relay.db npm run start:server
```

プログラムから利用する場合は `storageOptions.dbPath` を指定します：

```typescript
const server = new NostrRelayServer({
  port: 8008,
  storageOptions: { dbPath: '/var/lib/nostr-cache/relay.db' },
});
```

永続モード固有の挙動：

- `dbPath` 未指定なら**従来どおり**インメモリで、`stop()` 時にストレージをクリアします。
  永続モードでは `stop()` はデータを保持したまま DB を閉じます（WAL のチェックポイント +
  ファイルハンドル解放）。同一インスタンスを再度 `start()` すると DB は自動で
  再オープンされます
- TTL・保存上限・退避戦略・遅延バリデーションの永続キューは、永続モードでも
  インメモリと同一のセマンティクスで機能します
- `node:sqlite` は実験的機能のため、永続化を**有効にしたときだけ** ExperimentalWarning が
  1 回表示されます（機能には影響ありません。`NODE_OPTIONS=--disable-warning=ExperimentalWarning`
  で抑制できます）
- WAL モードで動作するため、DB ファイルの隣に `*.db-wal` / `*.db-shm` のサイドカー
  ファイルが作られます（`stop()` で本体へチェックポイントされます）
- 同一 DB ファイルを複数のサーバープロセスで同時に開くことはサポートしません
  （単一プロセス前提。誤操作に対しては `busy_timeout` で防御しています）
- クエリ層には Drizzle ORM（`drizzle-orm/node-sqlite`）を使用しています（エンジンは
  `node:sqlite` のまま）。SQL への値の埋め込みはすべて型付きのクエリビルダ経由です

## 環境変数

| 環境変数 | 内容 |
|---|---|
| `NOSTR_DB_PATH` | SQLite ファイルパス。指定すると永続化が有効になる |
| `NOSTR_CACHE_PRIORITY_PUBKEYS` | 優先キャッシュする pubkey（カンマ区切り。`npub1...` / hex） |
| `NOSTR_CACHE_PRIORITY_KINDS` | 優先キャッシュする kind（カンマ区切り） |

```bash
# 自分の npub と kind 0（プロフィール）を優先的にキャッシュして起動
NOSTR_CACHE_PRIORITY_PUBKEYS=npub1... \
NOSTR_CACHE_PRIORITY_KINDS=0 \
npm run start:server
```

不正な値を指定した場合は起動時にエラーで停止します。実行中の差し替えは
`server.setCachePriority(input)` で行えます（再起動不要）。優先イベントの扱いは
[doc/api.md](../../doc/api.md) の「退避・TTL・キャッシュ優先度の注意」を参照してください。

## 設定オプション

```typescript
interface NostrRelayServerOptions {
  // サーバー設定
  port: number;       // デフォルト: 8008
  host?: string;      // ホスト名

  // ストレージ設定
  storageOptions?: {
    dbName?: string;   // データベース名（既定のインメモリモードのみ）
    dbPath?: string;   // SQLite ファイルパス。指定すると永続化が有効になる（dbName は無視）
    maxSize?: number;  // 最大保存件数
    cacheStrategy?: 'LRU' | 'FIFO' | 'LFU';
    cachePriority?: { pubkeys?: string[]; kinds?: number[] };
  };

  // リレー設定（NostrRelayOptions へ素通し）
  relay?: {
    maxSubscriptions?: number;
    maxEventsPerRequest?: number;
    validateEvents?: boolean;      // false は validateEventsType: 'NONE' に対応
    ttl?: number;
    ttlSweepInterval?: number;
    upstreamRelays?: string[];
    upstreamEoseTimeout?: number;
    upstreamFreshness?: Record<number, number>;
  };

  // ヘルスチェック設定
  healthCheck?: {
    enabled?: boolean;  // 有効にするか（デフォルト: true）
    port?: number;      // HTTP ポート（デフォルト: WebSocket ポート + 1）
    path?: string;      // パス（デフォルト: '/health'）
  };
}
```

`relay` の各値はリレーコアの `NostrRelayOptions` へ素通しされます。意味・既定値・制約は
[doc/api.md](../../doc/api.md#interface-nostrrelayoptions) を参照してください。

> **注意（host バインドについて）**: `host` オプションはヘルスチェック用 HTTP サーバーには
> 適用されますが、現状の WebSocket サーバー（`@nostr-cache/cache-relay` の `WebSocketServer`）は
> `host` を受け取らず全インターフェースで待ち受けます。`host` で待ち受け範囲を厳密に
> 制限したい場合はこの非対称性に注意してください。

## ヘルスチェックエンドポイント

サーバー起動時、WebSocket ポートとは別の HTTP ポート（デフォルトは `port + 1`）で
ヘルスチェックエンドポイント（デフォルト `/health`）が起動します。

```bash
curl http://localhost:8009/health
# => {"status":"ok","uptime":12.34,"connections":1,"events":42}
```

- `status`: 常に `"ok"`（応答できる場合）
- `uptime`: プロセスの稼働秒数
- `connections`: 現在の WebSocket 接続数
- `events`: 保存済みイベント数

`/health` 以外のパスや `GET` 以外のメソッドには `404` を返します。
`healthCheck.enabled: false` で無効化できます。なお補助機能のため、ヘルスチェック用
ポートの確保に失敗してもリレー本体は停止せず、警告ログのみを出力します。
`healthCheck.port: 0` を指定すると OS による動的ポート割り当てになり、実際に
バインドされたポート番号は `getHealthPort()` で取得できます。

## プログラムからの利用

```typescript
import { NostrRelayServer } from '@nostr-cache/server';

const server = new NostrRelayServer({
  port: 9000,
  storageOptions: { dbName: 'MyNostrRelay', maxSize: 1000000 },
  relay: { maxSubscriptions: 200, maxEventsPerRequest: 1000 },
});

await server.start();
// ...
await server.stop();
```

`NostrRelayServer` のメソッド一覧は [doc/api.md](../../doc/api.md#class-nostrrelayserver)
を参照してください。
