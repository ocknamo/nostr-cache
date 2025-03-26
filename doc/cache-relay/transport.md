# トランスポートレイヤーの設計仕様書

## 1. 概要

トランスポートレイヤーは、Nostrクライアントとの通信を担当するコンポーネントです。
ブラウザ環境とNode.js環境の両方をサポートするため、2つの実装を提供しています。

## 2. アーキテクチャ

### 2.1 TransportAdapter インターフェース

トランスポートの実装は、以下のインターフェースに従います：

```typescript
interface TransportAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(clientId: string, message: NostrWireMessage): void;
  onMessage(callback: (clientId: string, message: NostrWireMessage) => void): void;
  onConnect(callback: (clientId: string) => void): void;
  onDisconnect(callback: (clientId: string) => void): void;
}
```

### 2.2 WebSocketServerEmulator（ブラウザ環境用）

#### 設計方針
- 標準のWebSocket APIとの互換性を維持
- 特定のURLのみをエミュレート（他のURLは通常のWebSocketを使用）
- イベントベースの非同期通信

#### 主要機能
- WebSocketのエミュレーション
  - グローバルWebSocketオブジェクトの置き換え
  - 指定されたURLのみをエミュレート
  - その他のURLは通常のWebSocketを使用
- イベントハンドリング
  - onopen: 接続確立時
  - onmessage: メッセージ受信時
  - onclose: 接続切断時
  - onerror: エラー発生時
- メッセージ処理
  - JSON形式のNostrメッセージのバリデーション
  - 非同期イベント処理

### 2.3 WebSocketServer（Node.js環境用）

#### 設計方針
- wsライブラリを使用したWebSocketサーバー
- クライアント接続の管理
- エラーハンドリング

#### 主要機能
- サーバー管理
  - ポート3000でのリッスン
  - クライアント接続の受け入れ
  - サーバーの起動/停止
- クライアント管理
  - UUIDによるクライアントの識別
  - 接続状態の追跡
  - 切断時のクリーンアップ
- メッセージ処理
  - JSON形式のNostrメッセージのバリデーション
  - エラーハンドリング
  - クライアントへのメッセージ送信

## 3. エラーハンドリング

### 3.1 WebSocketServerEmulator
- 無効なメッセージフォーマット
- 未サポートのURL
- 接続エラー

### 3.2 WebSocketServer
- サーバー起動エラー
- クライアント接続エラー
- メッセージパースエラー
- 送信エラー

## 4. テスト

### 4.1 WebSocketServerEmulator
- 接続テスト
  - デフォルトURL
  - カスタムURL
  - 未サポートURL
- イベントテスト
  - open
  - message
  - close
  - error
- メッセージ処理テスト
  - 有効なメッセージ
  - 無効なメッセージ

### 4.2 WebSocketServer
- サーバー管理テスト
  - 起動
  - 停止
- クライアント管理テスト
  - 接続
  - 切断
  - UUID生成
- メッセージ処理テスト
  - 送信
  - 受信
  - エラー処理

## 5. 実装の注意点

- イベントの非同期処理
  - WebSocketServerEmulatorでのsetTimeoutの使用
  - イベントの順序の保証
- メモリリーク防止
  - クライアント切断時のクリーンアップ
  - イベントリスナーの適切な解除
- エラーハンドリング
  - すべてのエラーケースの考慮
  - 適切なエラーメッセージの提供
- テストカバレッジ
  - エッジケースのテスト
  - 非同期処理のテスト
