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

着手前に書いた実装スケッチ（サーバー本体と統合テストのコード例）はここにあったが、
現行コードと乖離していたため削除した。正確な API は [doc/api.md](../api.md) と
`packages/server/src/nostr-relay-server.ts` を参照。

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
