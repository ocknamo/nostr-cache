# cache-relay 設計方針

## 1. 基本コンセプト

- **cache-relay**はブラウザ内で動作するNostrリレーの実装
- NIP-01とNIP-02に準拠したリレーインターフェースを提供
- バックエンドストレージとしてIndexedDB (Dexie.js使用)を使用
- テスト環境ではfake-indexeddbを使用してIndexedDBをエミュレート

## 2. アーキテクチャ

```
+---------------------+
|   Nostrクライアント   |
+----------+----------+
           |
           | WebSocket
           v
+----------+----------+
| WebSocketインターフェース |
+----------+----------+
           |
           v
+----------+----------+
|  メッセージハンドラ   |
+-----+--------+-----+
      |        |
      v        v
+-----+----+ +-+------------+
|イベント   | |サブスクリプション|
|ハンドラ   | |マネージャ      |
+-----+----+ +-----+--------+
      |            |
      v            v
+-----+----+ +-----+--------+
|イベント   | |フィルタ       |
|バリデータ | |マッチング     |
+-----+----+ +-----+--------+
      |            |
      v            |
+-----+------------+-----+
|     イベントストア      |
+-----+----------------+
      |
      v
+-----+----------------+
|   ストレージアダプタ    |
+-----+----------------+
      |
      v
+-----+----------------+
|     IndexedDB        |
|     (Dexie.js)       |
+-----+----------------+
```

## 3. 主要コンポーネント

### WebSocketインターフェース
- Nostrクライアントとの通信を処理
- WebSocketプロトコルの実装（ブラウザ環境ではWebSocketサーバーのエミュレーション）

### メッセージハンドラ
- NIP-01に準拠したメッセージの処理
- `EVENT`, `REQ`, `CLOSE`メッセージの処理
- `EVENT`, `OK`, `EOSE`, `CLOSED`, `NOTICE`メッセージの送信

### イベントハンドラ
- イベントの検証と保存
- イベントの種類（通常、置換可能、一時的、アドレス可能）に応じた処理

### サブスクリプション管理
- サブスクリプションの作成、更新、削除
- リアルタイムイベント通知の管理

### フィルタマッチング
- NIP-01に準拠したフィルタ処理
- 複雑なフィルタ条件の評価

### イベントストア
- イベントの保存と取得
- イベントの種類に応じた保存戦略の実装

### ストレージアダプタ
- IndexedDBの抽象化
- Dexie.jsを使用したIndexedDBの実装

## 4. ディレクトリ構造

> 注: ファイル名は kebab-case にリファクタ済み（旧 PascalCase 表記から変更）。共有の型は `@nostr-cache/shared` パッケージに分離されている。

```
packages/cache-relay/
├── src/
│   ├── index.ts                       # メインエントリーポイント
│   ├── core/                          # コア機能
│   │   ├── nostr-cache-relay.ts       # リレーの主要実装
│   │   ├── nostr-cache-relay.spec.ts  # リレーの単体テスト
│   │   ├── message-handler.ts         # メッセージ処理
│   │   ├── message-handler.spec.ts    # メッセージ処理の単体テスト
│   │   ├── subscription-manager.ts    # サブスクリプション管理
│   │   └── subscription-manager.spec.ts # サブスクリプション管理の単体テスト
│   ├── event/                         # イベント処理
│   │   ├── event-handler.ts           # イベント処理
│   │   ├── event-handler.spec.ts      # イベント処理の単体テスト
│   │   ├── event-validator.ts         # イベント検証（rx-nostr-crypto で実装済み）
│   │   └── event-validator.spec.ts    # イベント検証の単体テスト
│   ├── storage/                       # ストレージ
│   │   ├── storage-adapter.ts         # ストレージアダプタインターフェース
│   │   ├── dexie-storage.ts           # Dexie.jsを使用したIndexedDBアダプタ
│   │   └── dexie-storage.spec.ts      # IndexedDBアダプタの単体テスト
│   ├── transport/                     # 通信層
│   │   ├── transport-adapter.ts       # トランスポートアダプタインターフェース
│   │   ├── web-socket-server.ts       # WebSocketサーバー（Node.js用）
│   │   ├── web-socket-server.spec.ts  # WebSocketサーバーの単体テスト
│   │   ├── web-socket-server-emulator.ts # WebSocketエミュレーション（ブラウザ用）
│   │   └── web-socket-server-emulator.spec.ts # WebSocketエミュレーションの単体テスト
│   ├── utils/                         # ユーティリティ
│   │   ├── filter-utils.ts            # フィルタ処理ユーティリティ
│   │   └── filter-utils.spec.ts       # フィルタ処理の単体テスト
│   └── test/                          # 統合テスト・テスト補助
│       ├── setup-vitest.ts            # Vitest セットアップ
│       ├── event.integration.spec.ts  # イベント処理の統合テスト
│       ├── subscription.integration.spec.ts # サブスクリプションの統合テスト
│       ├── websocket.integration.spec.ts # WebSocket の統合テスト
│       └── utils/                     # テスト用ユーティリティ
├── package.json
└── tsconfig.json
```

## 5. 実装計画

1. **基本構造とインターフェースの実装** (1日)
   - ディレクトリ構造の作成
   - 基本インターフェースの定義
   - 単体テストの作成

2. **ストレージレイヤーの実装** (2日)
   - Dexie.jsの導入
   - DexieStorageの実装
   - fake-indexeddbのセットアップ
   - 単体テストの作成と実行

3. **トランスポートレイヤーの実装** (2日)
   - TransportAdapterインターフェースの実装
   - WebSocketServerの実装（Node.js用）
   - WebSocketServerEmulatorの実装（ブラウザ用）
   - 単体テストの作成と実行

4. **メッセージハンドリングの実装** (2日)
   - MessageHandlerの実装
   - EventHandlerの実装（検証は `rx-nostr-crypto` で実装済み）
   - 単体テストの作成と実行

5. **サブスクリプション管理の実装** (2日)
   - SubscriptionManagerの実装
   - フィルタマッチングの実装
   - 単体テストの作成と実行

6. **Node.jsサーバーの実装** (1日)
   - サーバーアプリケーションの実装
   - 統合テストの作成と実行

7. **ブラウザクライアントの実装** (1日)
   - クライアントアプリケーションの実装
   - 統合テストの作成と実行

8. **E2Eテストの実装** (2日)
   - Node.jsクライアント-サーバーテスト
   - ブラウザクライアント-サーバーテスト

9. **ドキュメントとサンプルの作成** (1日)
   - READMEの更新
   - APIドキュメントの作成
   - サンプルコードの整備

## 6. API設計

```typescript
// リレーインターフェース（現行の NostrCacheRelay 実装に準拠）
interface NostrRelay {
  // 接続管理
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // イベント処理
  publishEvent(event: NostrEvent): Promise<boolean>;

  // サブスクリプション管理
  subscribe(subscriptionId: string, filters: Filter[]): Promise<void>;
  unsubscribe(subscriptionId: string): boolean;

  // イベントリスナー（'error' を含む）
  on(event: 'connect' | 'disconnect' | 'error' | 'event' | 'eose', callback: Function): void;
  off(event: 'connect' | 'disconnect' | 'error' | 'event' | 'eose', callback: Function): void;
}

// リレーオプション（現行 API）
interface NostrRelayOptions {
  // サブスクリプション上限（デフォルト 20）
  maxSubscriptions?: number;

  // REQ 応答 / subscribe 再生で返す最大件数（デフォルト 500、超過時は新しい順）
  maxEventsPerRequest?: number;

  // イベント検証方式（'NONE' | 'IMMEDIATELY' | 'LAZY'）
  // 'LAZY' は受理・保存後にバックグラウンドで検証し不正を削除（in-process / transport 両経路）
  validateEventsType?: 'NONE' | 'IMMEDIATELY' | 'LAZY';
  // LAZY のバックグラウンド検証間隔 秒（デフォルト 60）
  lazyValidateInterval?: number;
  // LAZY の 1 回あたり検証件数（デフォルト 100）
  lazyValidateBatchSize?: number;

  // TTL 秒。古いイベントを定期スイープで削除（未指定で無効）
  ttl?: number;
  // TTL スイープの実行間隔 秒（デフォルト 60）
  ttlSweepInterval?: number;

  // WebSocket サーバーのポート（Node.js のみ）
  port?: number;

  // 以下は型定義のみで未実装（将来対応予定）
  storageMaxSize?: number;
  cacheStrategy?: 'LRU' | 'FIFO' | 'LFU';
}
```

> 旧版にあった `storage: 'indexeddb'` / `storageOptions` / `validateEvents`(boolean) は廃止され、`storageMaxSize` / `validateEventsType` 等へ置き換えられている。

## 7. 実装上の注意点

1. **IndexedDBの実装**
   - 直接使用せずDexie.jsをラッパーライブラリとして使用
   - https://github.com/dexie/Dexie.js を使用
   - テスト環境ではfake-indexeddbを使用

2. **イベント検証**
   - `rx-nostr-crypto` の `verifier` を用いて実装済み（`event-validator.ts`）
   - `validateEventsType` で検証方式を切り替え可能（即時検証は実装済み、遅延検証 `LAZY` は未実装）

3. **テスト戦略**
   - 各実装ステップごとに単体テストを作成・実行
   - fake-indexeddbを使用してブラウザ環境をエミュレート
   - E2Eテストを実装

4. **環境対応**
   - 開発環境: IndexedDB (Dexie.js)、WebSocketエミュレーション
   - テスト環境: fake-indexeddb、WebSocketエミュレーション
