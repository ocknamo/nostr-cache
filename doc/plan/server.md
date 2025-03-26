# Node.jsサーバー実装計画（fake-indexeddbを使用）

## 実装計画

### 1. サーバーアプリケーションの実装

#### a. 基本サーバー構造
- [ ] **NostrRelayServer**クラスの作成
  - [ ] WebSocketServerを使用したサーバー実装
  - [ ] 設定管理（ポート、ストレージタイプなど）
  - [ ] 起動/停止メソッド
  - [ ] ヘルスチェックエンドポイント

#### b. ストレージ実装
- [ ] **fake-indexeddb**を使用したインメモリストレージ
  - [ ] Node.js環境でDexieStorageをそのまま使用
  - [ ] fake-indexeddbを初期化してブラウザのIndexedDBをエミュレート
  - [ ] 既存のDexieStorageクラスの再利用

#### c. リレー機能の統合
- [ ] **NostrCacheRelay**の完全な統合
  - [ ] DexieStorageアダプタの初期化
  - [ ] WebSocketServerトランスポートとの接続
  - [ ] MessageHandlerとSubscriptionManagerの接続

### 2. 統合テストの作成と実行

#### a. サーバー起動/停止テスト
- [ ] サーバーの正常起動・停止の確認
- [ ] 設定パラメータの正しい適用の確認

#### b. NIP-01プロトコル準拠テスト
- [ ] `EVENT`メッセージ処理テスト
  - [ ] イベント受信と保存の確認
  - [ ] `OK`レスポンスの確認
- [ ] `REQ`メッセージ処理テスト
  - [ ] フィルタ適用の確認
  - [ ] イベント返送の確認
  - [ ] `EOSE`メッセージの確認
- [ ] `CLOSE`メッセージ処理テスト
  - [ ] サブスクリプション終了の確認
  - [ ] `CLOSED`レスポンスの確認

#### c. 特殊ケースとエラーハンドリングテスト
- [ ] 無効なメッセージ形式の処理
- [ ] 認証失敗の処理
- [ ] レート制限の処理
- [ ] 大量リクエスト時の動作

#### d. パフォーマンステスト
- [ ] 同時接続処理能力の検証
- [ ] イベント処理スループットの測定

## 実装詳細

### サーバー実装のメインファイル

```typescript
// packages/server/src/index.ts（メインサーバー実装）

// fake-indexeddbの自動セットアップ
import 'fake-indexeddb/auto';
import { NostrCacheRelay, WebSocketServer } from '@nostr-cache/cache-relay';
import { DexieStorage } from '@nostr-cache/cache-relay/dist/storage/DexieStorage';
import { logger } from '@nostr-cache/shared';

/**
 * Nostrリレーサーバーの設定オプション
 */
interface NostrRelayServerOptions {
  // サーバー設定
  port: number;
  host?: string;
  
  // ストレージ設定
  storageOptions?: {
    dbName?: string;
    maxSize?: number;
  };
  
  // リレー設定（NostrCacheRelayに渡すオプション）
  relay?: {
    maxSubscriptions?: number;
    maxEventsPerRequest?: number;
    validateEvents?: boolean;
  };
}

/**
 * Nostrリレーサーバークラス
 * NIP-01準拠のNostrリレーサーバーを実装
 */
class NostrRelayServer {
  private server: WebSocketServer;
  private relay: NostrCacheRelay;
  private storage: DexieStorage;
  private options: NostrRelayServerOptions;
  
  constructor(options: Partial<NostrRelayServerOptions> = {}) {
    // デフォルト設定とマージ
    this.options = {
      port: 8008,
      ...options,
    };
    
    // fake-indexeddbを使用したDexieStorageの初期化
    this.storage = new DexieStorage(
      this.options.storageOptions?.dbName || 'NostrRelay'
    );
    
    // WebSocketサーバーの作成
    this.server = new WebSocketServer(this.options.port);
    
    // リレーの初期化
    this.relay = new NostrCacheRelay(
      this.storage,
      this.server,
      {
        storage: 'indexeddb', // fake-indexeddbを使用
        storageOptions: {
          dbName: this.options.storageOptions?.dbName,
          maxSize: this.options.storageOptions?.maxSize,
        },
        maxSubscriptions: this.options.relay?.maxSubscriptions || 100,
        maxEventsPerRequest: this.options.relay?.maxEventsPerRequest || 500,
        validateEvents: this.options.relay?.validateEvents !== false,
      }
    );
  }
  
  /**
   * サーバーを起動
   */
  async start(): Promise<void> {
    await this.relay.connect();
    logger.info(`Nostr relay server started on port ${this.options.port}`);
  }
  
  /**
   * サーバーを停止
   */
  async stop(): Promise<void> {
    await this.relay.disconnect();
    // ストレージのクリーンアップ
    await this.storage.clear();
    // fake-indexeddbのリセット
    // @ts-ignore - fake-indexeddb types
    indexedDB = new IDBFactory();
    
    logger.info('Nostr relay server stopped');
  }
  
  /**
   * 接続数を取得
   */
  getConnectionCount(): number {
    // 実装が必要
    return 0;
  }
  
  /**
   * イベント数を取得
   */
  async getEventCount(): Promise<number> {
    // 実装が必要
    return 0;
  }
}

// CLIインターフェース
if (require.main === module) {
  const server = new NostrRelayServer();
  
  // シグナルハンドリング
  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
  
  // サーバー起動
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { NostrRelayServer };
```

### 統合テスト実装

```typescript
// packages/server/tests/integration/server.test.ts（サーバー統合テスト）

import WebSocket from 'ws';
import { NostrRelayServer } from '../../src/index';
import { createTestEvent } from '@nostr-cache/cache-relay/dist/test/utils/base.integration';

describe('NostrRelayServer', () => {
  let server: NostrRelayServer;
  let port: number;
  
  beforeEach(async () => {
    port = Math.floor(Math.random() * 10000) + 9000;
    server = new NostrRelayServer({ port });
    await server.start();
  });
  
  afterEach(async () => {
    await server.stop();
  });
  
  it('should accept WebSocket connections', async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    
    await new Promise<void>((resolve) => {
      client.on('open', () => {
        expect(client.readyState).toBe(WebSocket.OPEN);
        resolve();
      });
    });
    
    client.close();
  });
  
  it('should handle EVENT messages and respond with OK', async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    const event = await createTestEvent();
    
    // 接続待機
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });
    
    // OK応答待機
    const responsePromise = new Promise<any>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message[0] === 'OK' && message[1] === event.id) {
          resolve(message);
        }
      });
    });
    
    // イベント送信
    client.send(JSON.stringify(['EVENT', event]));
    
    // レスポンス検証
    const response = await responsePromise;
    expect(response[0]).toBe('OK');
    expect(response[1]).toBe(event.id);
    expect(response[2]).toBe(true);
    
    client.close();
  });
  
  // 他のテストケース（REQ、CLOSE、エラーケースなど）
});
```

## 利点

1. **テスト環境との一貫性**：
   - 統合テストですでに使用されているfake-indexeddbを本番環境でも利用することで、テスト環境と本番環境の一貫性が保たれます。

2. **実装の簡素化**：
   - 新しいストレージアダプタを作成する必要がなく、既存のDexieStorageをそのまま利用できます。

3. **メモリ効率**：
   - fake-indexeddbはインメモリで動作するため、ディスクI/Oのオーバーヘッドがなく、パフォーマンスが向上します。

4. **コードの再利用**：
   - 既存のコードベースを最大限に活用できます。

## 考慮事項

1. **メモリ使用量**：
   - インメモリDBのため、大量のデータを扱う場合はメモリ使用量に注意が必要です。
   - `maxSize`オプションを適切に設定して、メモリ使用量を制限することを検討してください。

2. **永続性**：
   - fake-indexeddbはサーバー再起動時にデータが失われるため、永続化が必要な場合は追加の対策が必要です。
   - 重要なデータを定期的にバックアップする機能を追加することを検討してください。
