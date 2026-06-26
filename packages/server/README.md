# Nostr Cache Server

**注意: このパッケージは開発中のため、一部の機能は正常に動作しません。**

NIP-01準拠のNostrリレーサーバー実装。このパッケージは`@nostr-cache/cache-relay`を使用してNostrリレーサーバーをローカルで実行できるようにします。

## 主な機能

- WebSocketを通じたNIP-01準拠のNostrリレープロトコルの実装
- イベントの保存と取得
- サブスクリプション管理
- イベントのバリデーション
- fake-indexedDBを使用したサーバーサイドでのデータ保存

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

### 設定オプション

`NostrRelayServer`クラスは以下の設定オプションをサポートしています：

```typescript
interface NostrRelayServerOptions {
  // サーバー設定
  port: number;       // デフォルト: 8008
  host?: string;      // ホスト名

  // ストレージ設定
  storageOptions?: {
    dbName?: string;   // データベース名
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
