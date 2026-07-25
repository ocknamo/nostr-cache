# Node.jsサーバー実装計画（fake-indexeddbを使用）

> **状況（2026-07 時点）**: 本計画の項目はレート制限・認証（NIP-42）・スループット測定を除き
> 実装済み。以下のチェックボックスは実装状況に合わせて更新してある。永続化は当初計画に
> 無かったオプトイン機能として別途追加済み（`node:sqlite` / `SqliteStorage`、下記「永続化」節）。
> 残タスクの一覧は [doc/TODO.md](../TODO.md) を参照。

## 実装計画

### 1. サーバーアプリケーションの実装

#### a. 基本サーバー構造
- [x] **NostrRelayServer**クラスの作成（`packages/server/src/nostr-relay-server.ts`）
  - [x] WebSocketServerを使用したサーバー実装
  - [x] 設定管理（ポート、ストレージタイプなど）
  - [x] 起動/停止メソッド
  - [x] ヘルスチェックエンドポイント（`health-server.ts`。WebSocket とは別ポート（既定 `port + 1`）の `/health`）

#### b. ストレージ実装
- [x] **fake-indexeddb**を使用したインメモリストレージ
  - [x] Node.js環境でDexieStorageをそのまま使用
  - [x] fake-indexeddbを初期化してブラウザのIndexedDBをエミュレート
  - [x] 既存のDexieStorageクラスの再利用
- [x] （計画外の追加）`node:sqlite` によるファイル永続化をオプトインで実装
  - `NOSTR_DB_PATH` / `storageOptions.dbPath` 指定時のみ `SqliteStorage` を使用。未指定なら上記のまま

#### c. リレー機能の統合
- [x] **NostrCacheRelay**の完全な統合
  - [x] DexieStorageアダプタの初期化
  - [x] WebSocketServerトランスポートとの接続
  - [x] MessageHandlerとSubscriptionManagerの接続

### 2. 統合テストの作成と実行

テストは `packages/server/tests/integration/`（server / nip01 / health-check / performance /
persistence / upstream）に配置。実プロセス相当の E2E は `e2e/tests/node/` にある。

#### a. サーバー起動/停止テスト
- [x] サーバーの正常起動・停止の確認（`server.spec.ts`）
- [x] 設定パラメータの正しい適用の確認（`server.spec.ts` / `health-check.spec.ts` / `upstream.spec.ts`）

#### b. NIP-01プロトコル準拠テスト（`nip01.spec.ts`）
- [x] `EVENT`メッセージ処理テスト
  - [x] イベント受信と保存の確認
  - [x] `OK`レスポンスの確認
- [x] `REQ`メッセージ処理テスト
  - [x] フィルタ適用の確認（ids / authors / タグ / limit / since・until の境界包含 / 複数フィルタの重複排除）
  - [x] イベント返送の確認
  - [x] `EOSE`メッセージの確認
- [x] `CLOSE`メッセージ処理テスト
  - [x] サブスクリプション終了の確認
  - [x] `CLOSED`レスポンスの確認

#### c. 特殊ケースとエラーハンドリングテスト
- [x] 無効なメッセージ形式の処理（不正 JSON / 未知タイプ / フィルタ無し REQ / 不正フィルタ / 署名不正イベント）
- [ ] 認証失敗の処理 — **未実装**。NIP-42（AUTH）自体が未対応のため、テストも存在しない
- [ ] レート制限の処理 — **未実装**。クライアント毎の購読数上限（`maxSubscriptions`）のテストはあるが、
  時間窓ベースの頻度制限は `message-handler` に無い（[doc/TODO.md](../TODO.md) 参照）
- [x] 大量リクエスト時の動作（`performance.spec.ts` のバースト投入・並行投入）

#### d. パフォーマンステスト
- [x] 同時接続処理能力の検証（`performance.spec.ts`。多数同時接続下での正当性を検証）
- [ ] イベント処理スループットの測定 — **スコープ外**。実行時間に依存する閾値アサーションは
  意図的に置いていない。ベンチマークが必要になった時点で別項目として起こす

## 実装詳細

> **注意**: 以下は実装着手前に書かれたスケッチであり、現行コードとは API が異なる
> （`storage: 'indexeddb'` / `storageOptions` / `validateEvents` はいずれも旧オプション名で、
> 現行は `storageMaxSize` / `validateEventsType` 等。`getConnectionCount()` /
> `getEventCount()` のスタブも実装済み）。現行の正確な API は
> [doc/api.md](../api.md) と `packages/server/src/nostr-relay-server.ts` を参照。

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
   - 既定の fake-indexeddb はサーバー再起動時にデータが失われます。
   - 永続化が必要な場合は、環境変数 `NOSTR_DB_PATH`（または `storageOptions.dbPath`）で
     `node:sqlite` によるファイル永続化にオプトインできます（実装済み・2026-07。
     詳細は [packages/server/README.md](../../packages/server/README.md) の
     「永続化（オプトイン）」参照）。
