# TODO リスト

プロジェクト調査（2026-06-24）にもとづく課題一覧。ビルド・テストを実行して検証した結果をまとめている。

## プロジェクト状況サマリ

| パッケージ | 役割 | 状況 |
|---|---|---|
| shared | 共有型・ユーティリティ | ビルド成功。テスト未実装 |
| cache-relay | ブラウザ内 Nostr リレー本体 | ビルド成功・テスト201件通過。コアは概ね実装済み（一部未実装オプションあり） |
| server | Node.js サーバー（fake-indexeddb利用） | ビルド失敗（型エラー）。テスト5件は通過 |
| web-client | Angular 製フロントエンド（POC） | ビルド成功。POC実装あり |

検証時点で `npm run build` はモノレポ全体としては失敗する（server の型エラーが原因）。
Vitest は型チェックを行わないためテストは通るが、ビルドで型エラーが露見する状態。

## 優先度: 高（ビルド / CI 復旧）

- [x] server のビルド型エラー修正: `packages/server/src/nostr-relay-server.ts` の `NostrCacheRelay` 生成時オプションを、現行の `NostrRelayOptions`（`storageMaxSize` / `validateEventsType` など）に合わせる
  - 原因: `NostrRelayOptions` のリファクタ（`storageOptions`→`storageMaxSize`、`validateEvents`→`validateEventsType`）に server 側が追従していない
  - 対応: `storageOptions` を `storageMaxSize` に、`validateEvents`（boolean）を `validateEventsType`（`'IMMEDIATELY'` / `'NONE'`）にマッピングするよう修正
- [x] `npm run build` がモノレポ全体で通ることを確認し、CI を緑に戻す
- [ ] 型チェックを CI / テストに組み込む（Vitest は型を見ないため `tsc --noEmit` 等を追加検討）

## 優先度: 中（cache-relay コア完成）

- [ ] `NostrCacheRelay.subscribe()` / `unsubscribe()` の本実装（現状はログ出力のみのプレースホルダ）
- [ ] `emit('event'|'eose')` のダミー値を実データに置換
- [ ] 未実装オプションの実装: `maxEventsPerRequest`, `storageMaxSize`, `ttl`, `cacheStrategy`(LRU/FIFO/LFU), 遅延バリデーション系（`lazyValidateInterval`, `lazyValidateBachSize`）
  - 注: `lazyValidateBachSize` は既存のタイポ（正: `lazyValidateBatchSize`）。実装時にリネームすると破壊的変更になる点に留意
- [ ] フィルタマッチロジックの重複（`subscription-manager.ts` と `utils/filter-utils.ts`）を共通化

## 優先度: 中（server 完成 — `doc/plan/server.md` 参照）

- [ ] `getConnectionCount()` / `getEventCount()` の実装（現状は `return 0` のスタブ）
- [ ] ヘルスチェックエンドポイントの追加
- [ ] NIP-01 準拠の統合テスト拡充（REQ / CLOSE / エラーケース / レート制限）
- [ ] 同時接続・スループットの性能テスト

## 優先度: 中（設計書 `doc/cache-relay/cache-relay.md` 由来の未完了項目）

設計書の実装計画（フェーズ8・9）にあって未着手の項目。なお主要コンポーネント（イベント種別処理・検証・NIP-01/02・ストレージ・トランスポート・購読管理）は実装済みのため対象外。

- [ ] E2E テストの実装（設計書フェーズ8）
  - Node.js クライアント–サーバー E2E
  - ブラウザ クライアント–サーバー E2E（現状は `packages/server/tests/integration` のみ）
- [ ] API ドキュメント / サンプルコードの整備（設計書フェーズ9）

## 優先度: 低（整備）

- [ ] shared パッケージのテスト追加（現状 `test` スクリプトは `echo 'Add test here'`）
- [ ] CI の `lint:check` を全パッケージ対象に拡大（現状は root `package.json` の `lint:check` が `--workspace=packages/web-client` 限定）
  - cache-relay / server / shared は biome、web-client は `ng lint` を使うため、両者を束ねる lint:check の方針を併せて検討する
- [ ] web-client POC の機能完成（タイムライン表示など）
- [ ] README の「未実装」記載を実態に合わせて更新
- [ ] 設計書 `doc/cache-relay/cache-relay.md` を現状に合わせて更新
  - イベント検証は「空実装」ではなく `rx-nostr-crypto` で実装済み
  - `NostrRelayOptions` の記載が旧 API（`storage: 'indexeddb'` / `storageOptions` / `validateEvents`）— 現行は `storageMaxSize` / `validateEventsType` 等。server のビルドエラーもこの旧形に起因
  - ディレクトリ構造が PascalCase 表記（現行は kebab-case にリファクタ済み）
