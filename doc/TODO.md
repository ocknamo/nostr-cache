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

## 優先度: 高（プロジェクトの目的達成 — 本丸機能の未着手項目）

プロジェクトの目的（[doc/concept.md](./concept.md) 参照: WebSocket をインターセプトして
クライアント層でローカルリレーをキャッシュとして動かし、最終的に上流リレーの手前に
透過的に挟まる「完全なキャッシュ」を実現する）に直結するが、まだ未着手の中核項目。
リレーコアや個別のコンポーネントは実装済みでも、これらが揃わない限り当初の目的は達成されない。

- [ ] **Web クライアントとローカルリレーのエンドツーエンド配線**（目的④）
  - `packages/web-client` の `nostr.service.ts` は現状、生の `new WebSocket('wss://nos.lol/')`
    で実リレーへ直結しており、`WebSocketServerEmulator` を一切経由していない。
    「Web クライアント → ローカルリレー（キャッシュ）」が実際に動くよう配線し、デモを用意する
  - 併せてエミュレータ（`packages/cache-relay/src/transport/web-socket-server-emulator.ts`）の
    設計上の問題を見直す:
    - インターセプト分岐内で `super(urlString, protocols)` を呼んでおり、横取りしたはずの URL へ
      実ネットワーク接続を張ってしまう（「ローカルで完結」という意図と矛盾）
    - `emulatedSocket` を単一保持しており複数接続を扱えない。実クライアントが複数リレーへ張る
      接続を一括インターセプトできない
    - 対象 URL が単一一致のみ。`connect()` がエミュレータへ URL を渡せない（`TransportAdapter.start()`
      が引数なし）ため、既定 `ws://localhost:3000` 以外を横取りできない
- [ ] **上流リレーへの透過キャッシュ化（リードスルー / ライトスルー）**（目的① — 「完全な Cache」の本丸）
  - 現状のローカルリレーは「自分が保存済みのイベントしか返さない独立リレー」であり、
    実リレー群の手前に挟まる透過キャッシュにはなっていない
  - リードスルー: `REQ` 受信時にローカルで結果が不足する場合、上流の実リレーへ問い合わせ、
    取得したイベントをローカルへ充填してからクライアントへ返す
  - ライトスルー: `EVENT`（投稿）をローカルへ保存しつつ、上流リレーへも転送する
  - 上流リレーへの接続管理・フォワーディング機構の設計が前提

## 優先度: 高（ビルド / CI 復旧）

- [x] server のビルド型エラー修正: `packages/server/src/nostr-relay-server.ts` の `NostrCacheRelay` 生成時オプションを、現行の `NostrRelayOptions`（`storageMaxSize` / `validateEventsType` など）に合わせる
  - 原因: `NostrRelayOptions` のリファクタ（`storageOptions`→`storageMaxSize`、`validateEvents`→`validateEventsType`）に server 側が追従していない
  - 対応: `storageOptions` を `storageMaxSize` に、`validateEvents`（boolean）を `validateEventsType`（`'IMMEDIATELY'` / `'NONE'`）にマッピングするよう修正
- [x] `npm run build` がモノレポ全体で通ることを確認し、CI を緑に戻す
- [x] 型チェックを CI / テストに組み込む（Vitest は型を見ないため `tsc --noEmit` 等を追加検討）
  - 各パッケージ（shared / cache-relay / server）に `tsconfig.typecheck.json`（`noEmit: true`・テストファイル含む）と `npm run typecheck` を追加。ルートに集約用 `typecheck` スクリプトを追加し、CI（`lint-and-test`）の build 直後に `npm run typecheck` を実行
  - 型チェック導入で露見したテストコードの型エラーを修正（vitest 移行漏れ: `jest.Mock`→`Mock` / `Mock<T>`→`Mocked<T>`、`validateEvents`→`validateEventsType`、`mockImplementation()` の引数欠落）
  - web-client は `ng build` で型チェックされるため typecheck スクリプト対象外

## 優先度: 中（cache-relay コア完成）

- [x] `NostrCacheRelay.subscribe()` / `unsubscribe()` の本実装（現状はログ出力のみのプレースホルダ）
  - `subscribe()`: ローカルクライアント（`LOCAL_CLIENT_ID`）として `SubscriptionManager` に購読を登録し、ストレージから一致イベントを取得して `event` リスナへ再生、最後に `eose` を発火（`Promise<void>` 化）
  - `unsubscribe()`: 該当購読を削除し、削除できたか否かを `boolean` で返す
- [x] `emit('event'|'eose')` のダミー値を実データに置換
  - `emit` をオーバーロード化し、`error`/`event`/`eose` に実ペイロード（`Error` / `NostrEvent` / `subscriptionId`）を渡すよう変更
  - `publishEvent()` 保存成功時、ローカル購読にマッチすれば `event` を発火するよう実装
  - 既知の制約（別タスク化）: `RelayEventHandler` がイベントのみ受領する型のため、`event` 通知は subscriptionId を伝えず、複数ローカル購読時にどの購読由来か判別できない。多重購読対応には `RelayEventHandler` への subscriptionId 追加が必要。また `subscribe()` のストレージ再生は `filter.limit` / `maxEventsPerRequest` 未適用（下記「未実装オプション」スコープ）
- [ ] 未実装オプションの実装: `storageMaxSize`, `cacheStrategy`(LRU/FIFO/LFU)
  - [x] `maxEventsPerRequest` の実装: REQ 受信時のストレージイベント送信数と、`subscribe()` のストレージ再生数に、リレー側の上限（既定 500）を適用。各フィルタの `limit` の上にかぶせる形でキャップする
  - [x] `ttl` の実装: `created_at` が `now - ttl` より古いイベントを、バックグラウンドの定期スイープ（`ExpiryReaper`）でストレージから一括削除（`DexieStorage.deleteExpired` を `created_at` インデックスで実行）。読み出し時フィルタは廃止し、読み出しコストをゼロ化＋容量回収。トレードオフとして最大 `ttlSweepInterval`（既定 60 秒）ぶん古いイベントを返しうる
  - [ ] 保存時刻ベース TTL（"キャッシュ投入からの経過時間"）の実装: 現行 `ttl` は `created_at`（イベント作成時刻）基準。投入時刻基準にするには、ストレージ層（`DexieStorage`）に保存時刻（`cached_at` 等）を持たせるスキーマ拡張と、それに基づくスイープ条件が必要
  - [x] 遅延バリデーション系（`validateEventsType: 'LAZY'` / `lazyValidateInterval` / `lazyValidateBatchSize`）: 保存後にバックグラウンドで定期的にバッチ検証し、不正イベントをストレージから削除。`LazyValidator` を追加し relay の connect/disconnect でタイマーを開始/停止。in-process `publishEvent()` とトランスポート経由 `EVENT` の**両経路**に適用（`MessageHandler` / `EventHandler` に検証モードを伝播し、`IMMEDIATELY` のみ同期検証・`NONE`/`LAZY` は入口検証をスキップ）。`LAZY` は保存されたイベントを一時受理・配信し得る（最大 `lazyValidateInterval` 秒）が、ephemeral など**保存されないイベントは後追い削除できないため LAZY でも同期検証**して即拒否する。ベータのため旧タイポ名 `lazyValidateBachSize` は削除（正: `lazyValidateBatchSize`）
- [x] フィルタマッチロジックの重複（`subscription-manager.ts` と `utils/filter-utils.ts`）を共通化
  - `subscription-manager.ts` の private `eventMatchesFilter` を削除し、`utils/filter-utils.ts` の共通実装を利用するよう統一

## 優先度: 中（server 完成 — `doc/plan/server.md` 参照）

- [x] `getConnectionCount()` / `getEventCount()` の実装（現状は `return 0` のスタブ）
  - `getConnectionCount()` は `TransportAdapter.getConnectionCount()`（WebSocketServer の接続数）、`getEventCount()` は `StorageAdapter.count()` を返すよう実装済み
- [x] ヘルスチェックエンドポイントの追加
  - `NostrRelayServer` 起動時に WebSocket ポートとは別の HTTP ポート（既定 `port + 1`）で `/health` を公開し、稼働状況（`status` / `uptime` / `connections` / `events`）を JSON で返す。`healthCheck` オプションで有効/無効・ポート・パスを設定可能。補助機能のためポート確保失敗時もリレー本体は停止しない
- [ ] NIP-01 準拠の統合テスト拡充（REQ / CLOSE / エラーケース / レート制限）
- [ ] 同時接続・スループットの性能テスト

## 優先度: 中（設計書 `doc/cache-relay/cache-relay.md` 由来の未完了項目）

設計書の実装計画（フェーズ8・9）にあって未着手の項目。なお主要コンポーネント（イベント種別処理・検証・NIP-01/02・ストレージ・トランスポート・購読管理）は実装済みのため対象外。

- [ ] E2E テストの実装（設計書フェーズ8）
  - Node.js クライアント–サーバー E2E
  - ブラウザ クライアント–サーバー E2E（現状は `packages/server/tests/integration` のみ）
- [x] API ドキュメント / サンプルコードの整備（設計書フェーズ9）
  - `doc/api.md` に主要パッケージ（shared / cache-relay / server）の公開 API リファレンスを追加
  - `examples/node-relay-demo.mjs` に `@nostr-cache/cache-relay` を使った実行可能な E2E デモ（EVENT/OK・REQ/EVENT/EOSE・CLOSE/CLOSED）と `examples/README.md` を追加

## 優先度: 低（整備）

- [x] shared パッケージのテスト追加（現状 `test` スクリプトは `echo 'Add test here'`）
  - `vitest` を導入し `message` / `relays` / `logger` / `crypto` / `message-to-wire` の単体テストを追加済み（#7）
- [x] CI の `lint:check` を全パッケージ対象に拡大（現状は root `package.json` の `lint:check` が `--workspace=packages/web-client` 限定）
  - cache-relay / server / shared は biome、web-client は `ng lint` を使うため、両者を束ねる lint:check の方針を併せて検討する
  - 対応: shared / cache-relay / server に `lint:check`（`biome check ./src`）を追加し、root の `lint:check` を `npm run lint:check --workspaces --if-present` に変更。biome 系 3 パッケージと web-client の `ng lint` を一括実行できるようにした
- [ ] TypeScript の最新化と tsconfig の deprecation 対応（TS 7.0 で破壊的変更）
  - `typescript` は `^5.0.0` 固定。最新系（TS 6.x / 将来の 7.0）では tsconfig の以下が deprecated でビルドエラーになる
    - `baseUrl`（TS5101）: `paths` のベースを相対指定にする等で `baseUrl` 依存を解消する
    - `moduleResolution: "node"`（= node10、TS5107）: `"bundler"` または `"node16"` / `"nodenext"` へ移行を検討
  - 当面の回避策として `ignoreDeprecations: "6.0"` を tsconfig に指定する手もあるが、根本対応として上記移行を推奨
  - TS バージョンを上げる際は cache-relay / server / web-client の各ビルドへの影響を確認する
- [ ] web-client POC の機能完成（タイムライン表示など）
- [x] README の「未実装」記載を実態に合わせて更新
  - 「現状（2026-06）」セクションを追加し、リレーコアは実装済み・CI 緑であること、未完成は E2E 配線と透過キャッシュ化・一部オプションであることを明記
- [x] 設計書 `doc/cache-relay/cache-relay.md` を現状に合わせて更新
  - イベント検証は「空実装」ではなく `rx-nostr-crypto` で実装済み
  - `NostrRelayOptions` の記載が旧 API（`storage: 'indexeddb'` / `storageOptions` / `validateEvents`）— 現行は `storageMaxSize` / `validateEventsType` 等。server のビルドエラーもこの旧形に起因
  - ディレクトリ構造が PascalCase 表記（現行は kebab-case にリファクタ済み）
