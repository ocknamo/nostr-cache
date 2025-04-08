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
}
```

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

## 注意事項

現在のサーバー実装では、以下の機能が未実装または一部実装されています：

- `getConnectionCount()`: 接続数を取得するメソッドは実装されていませんが、インターフェースは提供されています
- `getEventCount()`: イベント数を取得するメソッドは実装されていませんが、インターフェースは提供されています
- メトリクスや詳細な監視機能はまだ実装されていません

これらの機能は将来のアップデートで実装される予定です。

## 将来的な拡張

- RESTful APIサポート
- クラスタリングとスケーリング
- メトリクスとモニタリング
- 認証と認可
- パフォーマンス最適化
