# Nostr Cache Server

**注意: このパッケージは開発中のため、一部の機能は正常に動作しません。**

NIP-01準拠のNostrリレーサーバー実装。このパッケージは`@nostr-cache/cache-relay`を使用してNostrリレーサーバーをローカルで実行できるようにします。

## 主な機能

- WebSocketを通じたNIP-01準拠のNostrリレープロトコルの実装
- イベントの保存と取得
- サブスクリプション管理
- イベントのバリデーション
- サーバーサイドでのデータ保存（既定: fake-indexedDB によるインメモリ保存 /
  オプトイン: `node:sqlite` によるファイル永続化。下記「永続化（オプトイン）」参照）

## インストールと実行

ルートディレクトリから以下のコマンドを実行してください：

```bash
# サーバーパッケージをビルド
npm run build:server

# 開発モードでサーバーを起動
# 注意: 実行時に実験的機能の警告が表示されますが、機能には影響ありません
npm run dev:server

# 本番モードでサーバーを起動
npm run start:server
```

## 使用方法

サーバーはデフォルトで8008ポートで起動します。WebSocketクライアントを使用して接続できます。

## 永続化（オプトイン）

既定ではストレージは fake-indexedDB（インメモリ）で動作し、**プロセス終了で全イベントが
失われます**。環境変数 `NOSTR_DB_PATH` に SQLite データベースのファイルパスを指定すると、
Node.js 組み込みの `node:sqlite` による永続ストレージにオプトインでき、再起動をまたいで
イベントが保持されます（親ディレクトリは自動作成されます）。

```bash
# 永続化を有効にして起動
NOSTR_DB_PATH=/var/lib/nostr-cache/relay.db npm run start:server

# イベント投稿 → Ctrl-C（SIGINT）や docker stop（SIGTERM）で停止 → 再起動しても
# 保存済みイベントは REQ で取得できる
```

プログラムから利用する場合は `storageOptions.dbPath` を指定します：

```typescript
const server = new NostrRelayServer({
  port: 8008,
  storageOptions: { dbPath: '/var/lib/nostr-cache/relay.db' },
});
```

挙動の要点：

- `dbPath` 未指定なら**従来どおり**インメモリで、`stop()` 時にストレージをクリアします。
  永続モードでは `stop()` はデータを保持したまま DB を閉じます（WAL のチェックポイント +
  ファイルハンドル解放）。同一インスタンスを再度 `start()` すると DB は自動で
  再オープンされます
- TTL（`relay.ttl`）・保存上限（`storageOptions.maxSize` / `cacheStrategy` の
  FIFO / LRU / LFU）・遅延バリデーションの永続キューは、永続モードでもインメモリと
  同一のセマンティクスで機能します
- `node:sqlite` は実験的機能のため、永続化を**有効にしたときだけ** ExperimentalWarning が
  1 回表示されます（機能には影響ありません。`NODE_OPTIONS=--disable-warning=ExperimentalWarning`
  で抑制できます）
- WAL モードで動作するため、DB ファイルの隣に `*.db-wal` / `*.db-shm` のサイドカー
  ファイルが作られます（`stop()` で本体へチェックポイントされます）
- 同一 DB ファイルを複数のサーバープロセスで同時に開くことはサポートしません
  （単一プロセス前提。誤操作に対しては `busy_timeout` で防御しています）

### 設定オプション

`NostrRelayServer`クラスは以下の設定オプションをサポートしています：

```typescript
interface NostrRelayServerOptions {
  // サーバー設定
  port: number;       // デフォルト: 8008
  host?: string;      // ホスト名

  // ストレージ設定
  storageOptions?: {
    dbName?: string;   // データベース名（既定のインメモリモードのみ）
    dbPath?: string;   // SQLite ファイルパス。指定すると永続化が有効になる（dbName は無視）
    maxSize?: number;  // 最大サイズ
  };

  // リレー設定
  relay?: {
    maxSubscriptions?: number;     // 最大サブスクリプション数
    maxEventsPerRequest?: number;  // リクエストあたりの最大イベント数
    validateEvents?: boolean;      // イベントのバリデーションを行うかどうか
  };

  // ヘルスチェック設定
  healthCheck?: {
    enabled?: boolean;  // 有効にするか（デフォルト: true）
    port?: number;      // HTTP ポート（デフォルト: WebSocket ポート + 1）
    path?: string;      // パス（デフォルト: '/health'）
  };
}
```

### ヘルスチェックエンドポイント

サーバー起動時、WebSocket ポートとは別の HTTP ポート（デフォルトは `port + 1`）で
ヘルスチェックエンドポイント（デフォルト `/health`）が起動します。リレーの稼働状況を
JSON で返します。

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

> **注意（host バインドについて）**: `host` オプションはヘルスチェック用 HTTP サーバーには
> 適用されますが、現状の WebSocket サーバー（`@nostr-cache/cache-relay` の `WebSocketServer`）は
> `host` を受け取らず全インターフェースで待ち受けます。`host` で待ち受け範囲を厳密に
> 制限したい場合はこの非対称性に注意してください。

### プログラムからの利用

```typescript
import { NostrRelayServer } from '@nostr-cache/server';

// カスタム設定でサーバーを作成
const server = new NostrRelayServer({
  port: 9000,
  storageOptions: {
    dbName: 'MyNostrRelay',
    maxSize: 1000000
  },
  relay: {
    maxSubscriptions: 200,
    maxEventsPerRequest: 1000,
    validateEvents: true
  }
});

// サーバーを起動
await server.start();

// サーバーを停止
await server.stop();
```

## 実装状況

サーバーの監視系メソッドの実装状況は以下のとおりです：

- `getConnectionCount()`: **実装済み**。現在の接続数を返します（`WebSocketServer` の接続中クライアント数）
- `getEventCount()`: **実装済み**。保存済みイベント数を返します（`DexieStorage` のイベント件数）
- ヘルスチェックエンドポイント（`/health`）: **実装済み**。HTTP で稼働状況（接続数・イベント数・稼働時間）を返します（上記「ヘルスチェックエンドポイント」参照）
- より詳細なメトリクス（Prometheus 形式の出力等）は**未実装**です

未実装のメトリクス・監視機能は将来のアップデートで実装される予定です。

## 将来的な拡張

- RESTful APIサポート
- クラスタリングとスケーリング
- メトリクスとモニタリング
- 認証と認可
- パフォーマンス最適化
