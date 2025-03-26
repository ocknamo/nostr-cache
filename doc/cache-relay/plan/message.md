# メッセージハンドリング設計仕様書

## 1. 概要

メッセージハンドラは、WebSocketを通じて受信したNostrプロトコルメッセージを処理し、適切なレスポンスを返す役割を担います。
NIP-01に準拠したメッセージフォーマットを扱い、イベントハンドラやサブスクリプションマネージャと連携します。

## 2. アーキテクチャ

### 2.1 MessageHandler

#### 設計方針
- NIP-01準拠のメッセージフォーマット
- 非同期メッセージ処理
- 包括的なエラーハンドリング
- イベントベースの通信

#### 主要インターフェース
- メッセージの受信と解析
  - `handleMessage(clientId: string, wireMessage: NostrWireMessage): Promise<void>`
  - JSON形式の検証
  - メッセージタイプの判別
- メッセージタイプ別の処理
  - `handleEventMessage(clientId: string, message: EventMessage): Promise<void>`
  - `handleReqMessage(clientId: string, message: ReqMessage): Promise<void>`
  - `handleCloseMessage(clientId: string, message: CloseMessage): void`
- レスポンスの送信
  - `sendEvent(clientId: string, subscriptionId: string, event: NostrEvent): void`
  - `sendOK(clientId: string, eventId: string, success: boolean, message?: string): void`
  - `sendEOSE(clientId: string, subscriptionId: string): void`
  - `sendClosed(clientId: string, subscriptionId: string, message: string): void`
  - `sendNotice(clientId: string, message: string): void`
  - `onResponse(callback: (clientId: string, message: NostrWireMessage) => void): void`

#### 実装仕様
- メッセージのバリデーション
  - JSON形式の検証
  - 必須フィールドの存在確認
  - フィールド値の型チェック
- イベント処理
  - イベントバリデーション
  - イベントハンドラへの委譲
  - 成功/失敗レスポンスの送信
  - イベント受信者へのブロードキャスト
- サブスクリプション処理
  - サブスクリプションマネージャへの委譲
  - フィルタのバリデーションと適用
  - 既存イベントの検索と送信
  - EOSE（End of Stored Events）の送信
- エラーハンドリング
  - 不正なメッセージの処理
  - 例外のキャッチと適切な通知
  - セキュアなエラーメッセージの生成

## 3. データモデル

### 3.1 メッセージ型定義

```typescript
// メッセージ型定義
interface EventMessage {
  type: NostrMessageType.EVENT;
  event: NostrEvent;
  subscriptionId?: string;
}

interface ReqMessage {
  type: NostrMessageType.REQ;
  subscriptionId: string;
  filters: Filter[];
}

interface CloseMessage {
  type: NostrMessageType.CLOSE;
  subscriptionId: string;
}

// レスポンス型定義
interface OkResponse {
  type: NostrMessageType.OK;
  eventId: string;
  success: boolean;
  message?: string;
}

interface EoseResponse {
  type: NostrMessageType.EOSE;
  subscriptionId: string;
}

interface ClosedResponse {
  type: NostrMessageType.CLOSED;
  subscriptionId: string;
  message?: string;
}

interface NoticeResponse {
  type: NostrMessageType.NOTICE;
  message: string;
}
```

### 3.2 ワイヤーフォーマット

- EVENT: `["EVENT", <event>]`
- REQ: `["REQ", <subscription_id>, <filter>, ...]`
- CLOSE: `["CLOSE", <subscription_id>]`
- OK: `["OK", <event_id>, <success>, <message>]`
- EOSE: `["EOSE", <subscription_id>]`
- CLOSED: `["CLOSED", <subscription_id>, <message>]`
- NOTICE: `["NOTICE", <message>]`

## 4. 主要機能の仕様

### 4.1 イベント処理

1. **イベント受信**
   - クライアントからEVENTメッセージを受信
   - イベントの構造と署名を検証
   - 成功/失敗をOKメッセージで返信

2. **イベント保存と配信**
   - イベントを永続ストレージに保存
   - イベントに一致するサブスクリプションを検索
   - 該当するクライアントにイベントを配信

3. **置換可能イベント処理**
   - 同一著者の同一種類の既存イベントを置換
   - 最新のイベントのみを保持

### 4.2 サブスクリプション処理

1. **サブスクリプション作成**
   - クライアントからREQメッセージを受信
   - フィルタの構造を検証
   - サブスクリプションを登録

2. **既存イベントの検索と送信**
   - フィルタに一致する既存イベントを検索
   - 一致イベントをクライアントへ送信
   - EOSEメッセージを送信

3. **サブスクリプションの終了**
   - クライアントからCLOSEメッセージを受信
   - サブスクリプションを終了
   - CLOSEDメッセージを送信

### 4.3 エラーハンドリング

1. **メッセージバリデーション**
   - 不正なJSON形式を検出
   - 必須フィールドの欠落を検出
   - 型の不一致を検出

2. **エラー通知**
   - セキュアなエラーメッセージの生成
   - NOTICEメッセージによるクライアント通知
   - エラーの詳細をログに記録

3. **障害復旧**
   - 接続の維持
   - エラー状態からの回復
   - リソース解放の保証

## 5. 依存関係

### 5.1 内部依存

- **EventHandler**
  - イベントの検証と保存を担当
  - イベントのブロードキャストを支援

- **SubscriptionManager**
  - サブスクリプションの作成と管理
  - フィルタの適用とイベントマッチング
  - クライアントとサブスクリプションの関連付け

- **StorageAdapter**
  - イベントの永続化
  - イベントの検索
  - 置換可能イベントの管理

### 5.2 外部依存

- **WebSocketServer**
  - クライアント接続の管理
  - メッセージの送受信
  - 接続の監視

## 6. パフォーマンスと最適化

### 6.1 メッセージ処理

- 非同期処理によるスループット向上
- 効率的なイベントマッチング
- リソース使用量の最適化

### 6.2 メモリ管理

- 明示的なリソース解放
- メモリリークの防止
- キャッシュの適切な使用

### 6.3 スケーラビリティ

- 多数のクライアント接続の処理
- 高負荷状況での安定動作
- 効率的なサブスクリプション管理

## 7. テスト仕様

### 7.1 単体テスト

- **メッセージ処理テスト**
  - 各種メッセージフォーマットの検証
  - バリデーションロジックの確認
  - エラー処理の検証

- **イベント処理テスト**
  - イベント保存と検索の検証
  - イベントブロードキャストの確認
  - 置換可能イベントの処理確認

- **サブスクリプション処理テスト**
  - サブスクリプション管理の検証
  - フィルタ適用の確認
  - 複合フィルタの処理確認

### 7.2 統合テスト

- **WebSocket連携テスト**
  - クライアント接続の確認
  - メッセージ送受信の検証
  - 接続断の処理確認

- **ストレージ連携テスト**
  - イベント永続化の検証
  - クエリパフォーマンスの確認
  - データ整合性の検証

- **エンドツーエンドテスト**
  - 全コンポーネント連携の確認
  - 実際のクライアントシナリオの検証
  - パフォーマンス特性の評価

## 8. セキュリティ考慮事項

- クライアント入力の厳格な検証
- 安全なエラーメッセージの生成（内部詳細の隠蔽）
- メッセージサイズと頻度の制限
- リソース枯渇攻撃への対策

## 9. 実装ステータス

- 全ての主要コンポーネントの実装完了
- 単体テストと統合テストの完了
- 性能最適化の実施
- ドキュメント整備の完了
