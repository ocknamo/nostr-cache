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

```
packages/cache-relay/
├── src/
│   ├── index.ts                 # メインエントリーポイント
│   ├── core/                    # コア機能
│   │   ├── NostrCacheRelay.ts   # リレーの主要実装
│   │   ├── NostrCacheRelay.spec.ts # リレーの単体テスト
│   │   ├── MessageHandler.ts    # メッセージ処理
│   │   ├── MessageHandler.spec.ts # メッセージ処理の単体テスト
│   │   ├── SubscriptionManager.ts # サブスクリプション管理
│   │   └── SubscriptionManager.spec.ts # サブスクリプション管理の単体テスト
│   ├── event/                   # イベント処理
│   │   ├── EventHandler.ts      # イベント処理
│   │   ├── EventHandler.spec.ts # イベント処理の単体テスト
│   │   ├── EventValidator.ts    # イベント検証（空実装）
│   │   └── EventValidator.spec.ts # イベント検証の単体テスト
│   ├── storage/                 # ストレージ
│   │   ├── StorageAdapter.ts    # ストレージアダプタインターフェース
│   │   ├── DexieStorage.ts      # Dexie.jsを使用したIndexedDBアダプタ
│   │   └── DexieStorage.spec.ts # IndexedDBアダプタの単体テスト
│   ├── transport/               # 通信層
│   │   ├── TransportAdapter.ts  # トランスポートアダプタインターフェース
│   │   ├── WebSocketServer.ts   # WebSocketサーバー（Node.js用）
│   │   ├── WebSocketServer.spec.ts # WebSocketサーバーの単体テスト
│   │   ├── WebSocketEmulator.ts # WebSocketエミュレーション（ブラウザ用）
│   │   └── WebSocketEmulator.spec.ts # WebSocketエミュレーションの単体テスト
│   └── utils/                   # ユーティリティ
│       ├── filterUtils.ts       # フィルタ処理ユーティリティ
│       ├── filterUtils.spec.ts  # フィルタ処理の単体テスト
│       ├── types.ts             # 内部型定義
│       └── types.spec.ts        # 型定義の単体テスト
├── tests/                       # テスト
│   ├── integration/             # 統合テスト
│   │   ├── node/                # Node.js環境での統合テスト
│   └── browser-client/          # ブラウザクライアント例
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
   - WebSocketEmulatorの実装（ブラウザ用）
   - 単体テストの作成と実行

4. **メッセージハンドリングの実装** (2日)
   - MessageHandlerの実装
   - EventHandlerの実装（検証は空実装）
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
// リレーインターフェース
interface NostrRelay {
  // 接続管理
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // イベント処理
  publishEvent(event: NostrEvent): Promise<boolean>;
  
  // サブスクリプション管理
  subscribe(subscriptionId: string, filters: Filter[]): void;
  unsubscribe(subscriptionId: string): void;
  
  // イベントリスナー
  on(event: 'connect' | 'disconnect' | 'event' | 'eose', callback: Function): void;
  off(event: 'connect' | 'disconnect' | 'event' | 'eose', callback: Function): void;
}

// リレーオプション
interface NostrRelayOptions {
  // ストレージ設定
  storage: 'indexeddb';
  storageOptions?: {
    dbName?: string;
    maxSize?: number;
    ttl?: number;
  };
  
  // キャッシュ戦略
  cacheStrategy?: 'LRU' | 'FIFO' | 'LFU';
  
  // イベント処理設定
  validateEvents?: boolean;
  maxSubscriptions?: number;
  maxEventsPerRequest?: number;
}
```

## 7. 実装上の注意点

1. **IndexedDBの実装**
   - 直接使用せずDexie.jsをラッパーライブラリとして使用
   - https://github.com/dexie/Dexie.js を使用
   - テスト環境ではfake-indexeddbを使用

2. **イベント検証**
   - 空の関数で仮実装
   - 後でライブラリを導入予定

3. **テスト戦略**
   - 各実装ステップごとに単体テストを作成・実行
   - fake-indexeddbを使用してブラウザ環境をエミュレート
   - E2Eテストを実装

4. **環境対応**
   - 開発環境: IndexedDB (Dexie.js)、WebSocketエミュレーション
   - テスト環境: fake-indexeddb、WebSocketエミュレーション
