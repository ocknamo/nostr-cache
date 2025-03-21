# メッセージハンドリングの実装計画

## 1. 概要

メッセージハンドラは、WebSocketを通じて受信したNostrプロトコルメッセージを処理し、適切なレスポンスを返す役割を担います。
NIP-01に準拠したメッセージフォーマットを扱い、イベントハンドラやサブスクリプションマネージャと連携します。

## 2. コンポーネント

### 2.1 MessageHandler

#### 設計方針
- NIP-01準拠のメッセージフォーマット
- 非同期メッセージ処理
- エラーハンドリング
- イベントベースの通信

#### 主要機能
- メッセージの受信と解析
  - `handleMessage(message: string): Promise<void>`
  - JSON形式の検証
  - メッセージタイプの判別
- メッセージタイプ別の処理
  - `handleEvent(message: EventMessage): Promise<void>`
  - `handleReq(message: ReqMessage): Promise<void>`
  - `handleClose(message: CloseMessage): Promise<void>`
- レスポンスの送信
  - `sendEvent(event: NostrEvent): Promise<void>`
  - `sendOk(eventId: string, success: boolean, message?: string): Promise<void>`
  - `sendEose(subscriptionId: string): Promise<void>`
  - `sendClosed(subscriptionId: string): Promise<void>`
  - `sendNotice(message: string): Promise<void>`

#### 実装の詳細
- メッセージのバリデーション
  - JSON形式の検証
  - 必須フィールドの存在確認
  - フィールド値の型チェック
- イベント処理
  - イベントハンドラへの委譲
  - レスポンスの生成と送信
- サブスクリプション処理
  - サブスクリプションマネージャへの委譲
  - フィルタの解析と適用
- エラーハンドリング
  - 不正なメッセージの処理
  - 例外のキャッチと通知

## 3. テスト戦略

### 3.1 単体テスト

#### メッセージ受信のテスト
- 有効なメッセージ
  - EVENT メッセージ
  - REQ メッセージ
  - CLOSE メッセージ
- 無効なメッセージ
  - 不正な JSON
  - 不正なメッセージタイプ
  - 必須フィールドの欠落

#### イベント処理のテスト
- イベントの検証
- イベントの保存
- レスポンスの送信

#### サブスクリプション処理のテスト
- サブスクリプションの作成
- フィルタの適用
- イベントの配信
- サブスクリプションの終了

#### エラーハンドリングのテスト
- 不正なメッセージ
- 処理中のエラー
- 通知メッセージ

### 3.2 統合テスト
- WebSocketインターフェースとの連携
- イベントハンドラとの連携
- サブスクリプションマネージャとの連携

## 4. 実装手順

1. インターフェースの定義
   - MessageHandlerインターフェース
   - メッセージ型定義
   - レスポンス型定義

2. メッセージ処理の実装
   - メッセージの受信と解析
   - メッセージタイプ別の処理
   - レスポンスの送信

3. イベント処理の実装
   - イベントの検証
   - イベントの保存
   - レスポンスの生成

4. サブスクリプション処理の実装
   - サブスクリプションの管理
   - フィルタの適用
   - イベントの配信

5. エラーハンドリングの実装
   - エラーの検出
   - エラーメッセージの生成
   - エラー通知の送信

6. テストの実装と実行
   - 単体テストの作成
   - 統合テストの作成
   - エッジケースのテスト

## 5. 注意点

- メッセージの非同期処理
- メモリリークの防止
- エラーハンドリングの徹底
- テストカバレッジの確保

## 6. 今後の課題

- パフォーマンスの最適化
- エラーハンドリングの強化
- テストケースの追加
- ドキュメントの整備

## 7. インターフェース定義

```typescript
interface MessageHandler {
  // メッセージ処理
  handleMessage(message: string): Promise<void>;
  
  // イベント処理
  handleEvent(message: EventMessage): Promise<void>;
  handleReq(message: ReqMessage): Promise<void>;
  handleClose(message: CloseMessage): Promise<void>;
  
  // レスポンス送信
  sendEvent(event: NostrEvent): Promise<void>;
  sendOk(eventId: string, success: boolean, message?: string): Promise<void>;
  sendEose(subscriptionId: string): Promise<void>;
  sendClosed(subscriptionId: string): Promise<void>;
  sendNotice(message: string): Promise<void>;
}

// メッセージ型定義
interface EventMessage {
  type: 'EVENT';
  event: NostrEvent;
}

interface ReqMessage {
  type: 'REQ';
  subscriptionId: string;
  filters: Filter[];
}

interface CloseMessage {
  type: 'CLOSE';
  subscriptionId: string;
}

// レスポンス型定義
interface OkResponse {
  type: 'OK';
  eventId: string;
  success: boolean;
  message?: string;
}

interface EoseResponse {
  type: 'EOSE';
  subscriptionId: string;
}

interface ClosedResponse {
  type: 'CLOSED';
  subscriptionId: string;
}

interface NoticeResponse {
  type: 'NOTICE';
  message: string;
}
```

## 8. 依存関係

- WebSocketインターフェース
  - メッセージの送受信
  - 接続管理

- イベントハンドラ
  - イベントの検証
  - イベントの保存
  - イベントの取得

- サブスクリプションマネージャ
  - サブスクリプションの管理
  - フィルタの適用
  - イベントの配信

## 9. エラーハンドリング

### 9.1 エラーの種類
- メッセージパースエラー
- バリデーションエラー
- 処理エラー
- 通信エラー

### 9.2 エラー通知
- NOTICEメッセージの送信
- エラーログの記録
- メトリクスの更新

### 9.3 エラーリカバリー
- 接続の維持
- 状態の回復
- リトライ処理

## 10. パフォーマンス考慮事項

### 10.1 メッセージ処理
- 非同期処理の活用
- バッファリング
- スロットリング

### 10.2 メモリ管理
- メモリリークの防止
- キャッシュの制御
- リソースの解放

### 10.3 スケーラビリティ
- 並行処理
- キューイング
- バックプレッシャー
