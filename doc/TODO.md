# TODO リスト

プロジェクト調査（2026-06-24）にもとづく課題一覧。ビルド・テストを実行して検証した結果をまとめている。

## プロジェクト状況サマリ

| パッケージ | 役割 | 状況 |
|---|---|---|
| shared | 共有型・ユーティリティ | ビルド成功。テスト未実装 |
| cache-relay | ブラウザ内 Nostr リレー本体 | ビルド成功・テスト201件通過。コアは概ね実装済み（一部未実装オプションあり） |
| server | Node.js サーバー（fake-indexeddb利用） | ビルド失敗（型エラー）。テスト5件は通過 |
| web-client | Angular 製フロントエンド（POC） | ビルド成功。POC実装あり → **廃棄済み（2026-07）**。その後 Svelte 製で作り直し（下記 目的④ 参照） |

検証時点で `npm run build` はモノレポ全体としては失敗する（server の型エラーが原因）。
Vitest は型チェックを行わないためテストは通るが、ビルドで型エラーが露見する状態。
（注: 上記はいずれも調査時点のスナップショット。ビルド・CI はその後復旧済みで、
web-client は 2026-07 に廃棄した）

## 優先度: 高（プロジェクトの目的達成 — 本丸機能の未着手項目）

プロジェクトの目的（[doc/concept.md](./concept.md) 参照: WebSocket をインターセプトして
クライアント層でローカルリレーをキャッシュとして動かし、最終的に上流リレーの手前に
透過的に挟まる「完全なキャッシュ」を実現する）に直結するが、まだ未着手の中核項目。
リレーコアや個別のコンポーネントは実装済みでも、これらが揃わない限り当初の目的は達成されない。

- [x] **Web クライアントとローカルリレーのエンドツーエンド配線**（目的④）
  - `packages/web-client`（Svelte 5 + Vite）として実装（2026-07）。起動時に
    `DexieStorage`（IndexedDB）+ `WebSocketServerEmulator` + `NostrCacheRelay` を組み立て、
    クライアントは素の `new WebSocket('ws://nostr-cache.invalid')` で接続（エミュレータが横取り）。
    タイムライン表示・NIP-01 フィルタフォーム・kind1 投稿フォームを備え、投稿は IndexedDB に
    永続化されてリロード後も再購読で再生される（＝ローカルキャッシュとして機能）。
    URL を差し替えれば実リレー（`wss://…`）にも同一 UI で直結できる
  - 注: 旧 Angular 製 web-client（生の `new WebSocket('wss://nos.lol/')` で実リレーへ直結し、
    `WebSocketServerEmulator` を一切経由していなかった）は廃棄済みで、上記は軽量構成での作り直し
  - [x] エミュレータ（`packages/cache-relay/src/transport/web-socket-server-emulator.ts`）の
    設計上の問題を修正（2026-07）:
    - [x] インターセプト分岐内の `super(urlString, protocols)` による実ネットワーク接続を排除。
      元 WebSocket を継承せず、EventTarget ベースの `EmulatedWebSocket`（WebSocket インターフェイス
      互換）を返す構成に変更し、対象 URL への接続はネットワークに一切出ない
    - [x] 単一 `emulatedSocket` 保持を `Map<clientId, socket>`（clientId は `randomUUID`）へ変更し、
      複数同時接続に対応
    - [x] 対象 URL をコンストラクタで指定可能に（単数または配列、URL 正規化で末尾スラッシュ差異を
      吸収）。`TransportAdapter.start()` の引数なしのままリレー経由で任意 URL を横取りできる
- [x] **上流リレーへの透過キャッシュ化（リードスルー / ライトスルー）**（目的① — 「完全な Cache」の本丸）
  - `packages/cache-relay/src/upstream/` に上流接続・フォワーディング機構を新設
    （`UpstreamConnection`（1リレー1ソケット・指数バックオフ再接続・購読再確立）/
    `UpstreamRelayPool`（複数リレーへのファンアウトと EOSE 集約）/
    `UpstreamCoordinator`（購読対応表・重複排除・backfill・EOSE 保留・クリーンアップ））。
    設計詳細は [doc/cache-relay/upstream.md](./cache-relay/upstream.md)
  - リードスルー: `REQ` を常に上流へ転送。ローカル結果は即返しつつ、上流イベントを
    `event.id` で重複排除し、`MessageHandler.ingestUpstreamEvent`（通常 EVENT と同じ検証・
    保存・置換・遅延検証・上限退避）でローカルへ充填してからクライアントへ配信。
    上流購読はクライアントの CLOSE / 切断まで維持し、EOSE 後のライブイベントも透過配信する
  - ライトスルー: `EVENT` をローカル保存後、上流へ fire-and-forget で転送
    （クライアントへの `OK` はローカル保存の成否で即応答）
  - オプトイン: `NostrRelayOptions.upstreamRelays`（+ `upstreamEoseTimeout` /
    `upstreamConnectionTimeout` / テスト用 `upstreamPool`）。未指定なら従来どおり独立リレー。
    server（`relay.upstreamRelays`）・web-client（`startLocalRelay(url, { upstreamRelays })`）へも素通し
  - 上流クライアントは Node 22 ネイティブ / ブラウザの `WebSocket` のみ使用（`ws` 非依存）。
    ブラウザではエミュレータの差し替え前 `WebSocket`（`getOriginalWebSocket()`）を遅延取得し、
    横取り URL を上流指定した場合の自己接続ループを防ぐ
  - 付随修正: クライアント切断時にローカル購読が削除されていなかった既存のリークを、
    `MessageHandler.handleClientDisconnect`（`removeAllSubscriptions` + 上流購読クローズ）で解消

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
- [x] 未実装オプションの実装（すべて完了）
  - [x] `maxEventsPerRequest` の実装: REQ 受信時のストレージイベント送信数と、`subscribe()` のストレージ再生数に、リレー側の上限（既定 500）を適用。各フィルタの `limit` の上にかぶせる形でキャップする
  - [x] `ttl` の実装: `created_at` が `now - ttl` より古いイベントを、バックグラウンドの定期スイープ（`ExpiryReaper`）でストレージから一括削除（`DexieStorage.deleteExpired` を `created_at` インデックスで実行）。読み出し時フィルタは廃止し、読み出しコストをゼロ化＋容量回収。トレードオフとして最大 `ttlSweepInterval`（既定 60 秒）ぶん古いイベントを返しうる（注: スイープ基準は後に `cached_at` 基準へ変更、次項参照）
  - [x] 保存時刻ベース TTL（"キャッシュ投入からの経過時間"）の実装: `DexieStorage` のスキーマに保存時刻 `cached_at`（ミリ秒）とインデックスを追加（未リリースのため LRU/LFU メタデータ同様 v1 に直接定義）。`deleteExpired` のスイープ条件を `created_at`（イベント作成時刻）基準から `cached_at`（キャッシュ投入時刻）基準へ変更。置換可能イベント等の再 put では `cached_at` もリセットされ TTL が更新される
  - [x] 遅延バリデーション系（`validateEventsType: 'LAZY'` / `lazyValidateInterval` / `lazyValidateBatchSize`）: 保存後にバックグラウンドで定期的にバッチ検証し、不正イベントをストレージから削除。`LazyValidator` を追加し relay の connect/disconnect でタイマーを開始/停止。in-process `publishEvent()` とトランスポート経由 `EVENT` の**両経路**に適用（`MessageHandler` / `EventHandler` に検証モードを伝播し、`IMMEDIATELY` のみ同期検証・`NONE`/`LAZY` は入口検証をスキップ）。`LAZY` は保存されたイベントを一時受理・配信し得る（最大 `lazyValidateInterval` 秒）が、ephemeral など**保存されないイベントは後追い削除できないため LAZY でも同期検証**して即拒否する。ベータのため旧タイポ名 `lazyValidateBachSize` は削除（正: `lazyValidateBatchSize`）
  - [x] `storageMaxSize` + `cacheStrategy`（FIFO）: `StorageAdapter.enforceLimit?(maxSize, strategy)` を追加（`DexieStorage` で `created_at` インデックスのトランザクション一括削除として実装）。relay が `NostrRelayOptions.storageMaxSize`/`cacheStrategy` を保持し、保存成功後（in-process `publishEvent` / transport `EVENT` 両経路）に `storage.enforceLimit` を呼ぶ（TTL の `deleteExpired` と同じ relay オーケストレーション）
  - [x] `cacheStrategy` の `LRU` / `LFU` の本実装: `DexieStorage` のスキーマに `last_accessed_at`（ミリ秒）/ `access_count` とインデックス（`last_accessed_at` / `[access_count+last_accessed_at]`）を追加（未リリースのためマイグレーションは設けず v1 に直接定義）。`getEvents` のヒット時に両メタデータを一括更新（アクセス追跡。失敗しても読み出しには影響させない）。`enforceLimit` は戦略ごとに退避順を切替（FIFO=`created_at` / LRU=`last_accessed_at` / LFU=参照回数→最終アクセスの複合インデックス）。挿入も1回のアクセス（`access_count: 1`）とみなす
- [x] フィルタマッチロジックの重複（`subscription-manager.ts` と `utils/filter-utils.ts`）を共通化
  - `subscription-manager.ts` の private `eventMatchesFilter` を削除し、`utils/filter-utils.ts` の共通実装を利用するよう統一

## 優先度: 中（server 完成 — `doc/plan/server.md` 参照）

- [x] `getConnectionCount()` / `getEventCount()` の実装（現状は `return 0` のスタブ）
  - `getConnectionCount()` は `TransportAdapter.getConnectionCount()`（WebSocketServer の接続数）、`getEventCount()` は `StorageAdapter.count()` を返すよう実装済み
- [x] ヘルスチェックエンドポイントの追加
  - `NostrRelayServer` 起動時に WebSocket ポートとは別の HTTP ポート（既定 `port + 1`）で `/health` を公開し、稼働状況（`status` / `uptime` / `connections` / `events`）を JSON で返す。`healthCheck` オプションで有効/無効・ポート・パスを設定可能。補助機能のためポート確保失敗時もリレー本体は停止しない
- [x] NIP-01 準拠の統合テスト拡充（REQ / CLOSE / エラーケース / 購読数上限）
  - `packages/server/tests/integration/nip01.spec.ts` として実装済み（#13）。REQ のフィルタ適用（ids / authors / #p タグ / limit / since・until と since 境界の包含性 / 複数フィルタの重複排除 / 置換可能イベント）、エラーケース（不正メッセージ / 未知タイプ / フィルタ無し REQ / 不正フィルタ / 署名不正イベント）、CLOSE（未知購読の CLOSED / CLOSE 後の配信停止）、購読上限（`maxSubscriptions` 超過時の NOTICE 拒否）を実 WebSocket 経由で検証
  - 注: 元の項目名の「レート制限」はクライアント毎の購読同時保持数キャップ（`maxSubscriptions`）で代替している。時間窓ベースの真のレート制限は未実装（下記別項目）
- [ ] 時間窓ベースのレート制限（メッセージ / EVENT 投稿の頻度制限）の実装とテスト
  - 現状はクライアント毎の購読数上限のみで、単位時間あたりのリクエスト頻度を制限する仕組み（スロットリング）は `message-handler` に存在しない
- [x] 同時接続・負荷下の正当性テスト（旧: 同時接続・スループットの性能テスト）
  - `packages/server/tests/integration/performance.spec.ts` として実装済み（#15）。多数の同時接続、単一クライアントからのバースト投入、複数クライアントからの並行投入、並行 REQ の全件応答（取りこぼし無し）を検証
  - 注: 実行時間に依存する閾値アサーションは意図的に行っておらず、スループット（件/秒）やレイテンシの測定・回帰検知はスコープ外。ベンチマークが必要になったら別項目として起こす

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
- [x] tsconfig の deprecation 対応（TS 6/7 で削除される設定の解消）
  - root tsconfig を `moduleResolution: "node"`（node10、TS5107）から `"NodeNext"`（`module: "NodeNext"`）へ移行し、`baseUrl`（TS5101）と `paths` を削除（`@nostr-cache/*` は workspaces の node_modules 経由で解決されるため不要だった）
  - 付随修正: dexie を named import 化（NodeNext では CJS の default import が型エラー）、テストの拡張子なし相対 import に `.js` を付与、server tsconfig の冗長な `target`/`module` 上書きを削除
  - build 用 tsconfig の `types` を明示（`["node"]`）し、cache-relay の `src/test/**` を build 対象から除外（テスト補助ファイルが dist に混入していた）。TS 6 は @types の自動取り込みに依存しないよう要求するため、この明示が TS 6 対応の前提
  - shared / cache-relay / server は TS 6.0.3 でのビルド通過を確認済み
- [x] TypeScript 本体の最新化（TS 6 系への引き上げ）
  - 経緯: web-client の Angular 19（`@angular/compiler-cli`）が TS `>=5.5 <5.9` を要求するため、モノレポで TS 6 に上げると npm の dedupe で web-client のビルドが壊れる状態だった（検証済み）。**方針決定（2026-07）: 現行の Angular 製 web-client は一旦すべて廃棄する**ことで制約を解消
  - 対応: web-client 廃棄（下記）後、root と全パッケージ（shared / cache-relay / server）の `typescript` を `^6.0.0`（6.0.3）へ更新。build / typecheck / test の通過を確認
- [x] web-client（Angular 製 POC）の廃棄
  - 方針: 現行実装は一旦すべて捨てる（機能完成させない）
  - 対応: `packages/web-client` を削除し、root の workspaces / `build:web-client` / `dev:web-client` から除外。web-client 専用だった root の `eslint` devDependency も削除（残パッケージは biome を使用）。CI（lint-and-test）は root スクリプト経由のため変更不要
  - E2E 配線のデモ（優先度: 高の項目）を再開する際は、必要になった時点で軽量な構成のクライアントを作り直す
- [x] README の「未実装」記載を実態に合わせて更新
  - 「現状（2026-06）」セクションを追加し、リレーコアは実装済み・CI 緑であること、未完成は E2E 配線と透過キャッシュ化・一部オプションであることを明記
- [x] 設計書 `doc/cache-relay/cache-relay.md` を現状に合わせて更新
  - イベント検証は「空実装」ではなく `rx-nostr-crypto` で実装済み
  - `NostrRelayOptions` の記載が旧 API（`storage: 'indexeddb'` / `storageOptions` / `validateEvents`）— 現行は `storageMaxSize` / `validateEventsType` 等。server のビルドエラーもこの旧形に起因
  - ディレクトリ構造が PascalCase 表記（現行は kebab-case にリファクタ済み）
