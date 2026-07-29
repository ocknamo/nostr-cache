# TODO リスト

プロジェクト調査（2026-06-24）にもとづく課題一覧。ビルド・テストを実行して検証した結果をまとめている。

## プロジェクト状況サマリ

| パッケージ | 役割 | 状況 |
|---|---|---|
| shared | 共有型・ユーティリティ | ビルド成功。テスト未実装 |
| cache-relay | ブラウザ内 Nostr リレー本体 | ビルド成功・テスト201件通過。コアは概ね実装済み（一部未実装オプションあり） |
| server | Node.js サーバー（既定 fake-indexeddb / オプトインで node:sqlite 永続化） | ビルド失敗（型エラー）。テスト5件は通過 → その後復旧・拡充済み |
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
  - [x] 検証状態の DB 永続化: `DexieStorage` のスキーマに `validated`（0/1）カラムと複合インデックス `[validated+cached_at]` を追加（未リリースのため v1 に直接定義）。遅延検証のキューを**メモリからストレージ自体へ移行**（`LazyValidator` の `enqueue`/`maxQueueSize`/`flush` を廃止し、`getUnvalidatedEvents` で未検証分を古い順にバッチ取得 → 検証成功は `markValidated` 一括、失敗は削除）。リロード/クラッシュでキューが消えて未検証イベントが残留する問題と、キュー上限超過での取りこぼしを解消（`connect()` 時に即時1回パスを実行して再開）。`IMMEDIATELY` で保存されるイベントは `validated=1`、`NONE`/`LAZY` は `0` で保存し、再保存で 1→0 にダウングレードしない。新公開 API `relay.getValidationStatus(ids)`（主キー bulkGet、アクセス追跡なし）で組み込みクライアントがリレーの検証結果を再利用でき、web-client にタイムラインの検証済み ✓ バッジとして実装（`LAZY` 起動 + デバウンス取得 + pending が残る間のみポーリング）
  - [x] `storageMaxSize` + `cacheStrategy`（FIFO）: `StorageAdapter.enforceLimit?(maxSize, strategy)` を追加（`DexieStorage` で `created_at` インデックスのトランザクション一括削除として実装）。relay が `NostrRelayOptions.storageMaxSize`/`cacheStrategy` を保持し、保存成功後（in-process `publishEvent` / transport `EVENT` 両経路）に `storage.enforceLimit` を呼ぶ（TTL の `deleteExpired` と同じ relay オーケストレーション）
  - [x] `cacheStrategy` の `LRU` / `LFU` の本実装: `DexieStorage` のスキーマに `last_accessed_at`（ミリ秒）/ `access_count` とインデックス（`last_accessed_at` / `[access_count+last_accessed_at]`）を追加（未リリースのためマイグレーションは設けず v1 に直接定義）。`getEvents` のヒット時に両メタデータを一括更新（アクセス追跡。失敗しても読み出しには影響させない）。`enforceLimit` は戦略ごとに退避順を切替（FIFO=`created_at` / LRU=`last_accessed_at` / LFU=参照回数→最終アクセスの複合インデックス）。挿入も1回のアクセス（`access_count: 1`）とみなす
  - [x] `cachePriority`（pubkey / kind 単位のキャッシュ優先度、2026-07）: `NostrRelayOptions.cachePriority { pubkeys, kinds }` を追加（pubkey は npub / hex 両対応。`normalizeCachePriority` が `resolveRelayOptions` 内で hex に正規化し、不正値は生成時に fail-fast）。優先イベントは `storageMaxSize` 超過時に最後まで残り（ソフト優先: 非優先を先に退避し、優先のみになったら通常戦略順で退避。maxSize は厳守）、TTL スイープ（`deleteExpired`）の削除対象外。実装は退避時評価（priority カラムは**永続化しない**設計。設定変更時の stale 問題と Dexie / Drizzle / 手書き DDL の三重スキーマ変更・既存 SQLite ファイルのマイグレーションを回避するため）で、`enforceLimit` / `deleteExpired` の optional 引数として per-call に渡す。判定純関数は `cache-relay/storage/priority.ts` に置き Dexie / SQLite で共有（`getIndexedTags` と同じパターン）。NIP-19 デコーダ（bech32、npub のみ）は `shared/utils/nip19.ts` に自作（依存追加なし）。server は `storageOptions.cachePriority` と環境変数 `NOSTR_CACHE_PRIORITY_PUBKEYS` / `NOSTR_CACHE_PRIORITY_KINDS` で公開。実行時差し替え API `relay.setCachePriority(input?)`（server は同名で委譲）も提供 — 退避時評価のためバックフィル不要で、次回の退避・TTL スイープから即反映（不正値は例外で現行設定を維持、`undefined` で解除）
- [x] フィルタマッチロジックの重複（`subscription-manager.ts` と `utils/filter-utils.ts`）を共通化
  - `subscription-manager.ts` の private `eventMatchesFilter` を削除し、`utils/filter-utils.ts` の共通実装を利用するよう統一
- [x] Dexie ストレージの NIP-01 準拠フィルタ修正（2026-07）
  - 経緯: `SqliteStorage` 実装時に「Dexie との既知の差分」として記録していた 2 点を精査したところ、
    いずれも Dexie 側の NIP-01 違反（バグ）だったため修正した。本命であるブラウザ内キャッシュ経路に
    出ていた不具合で、`SqliteStorage` が正しい参照実装として機能した形
  - `filter.limit` の切り詰めが「最新 N 件」になっていなかった: `dexie-storage.ts` の
    `Collection.limit()` は選ばれたインデックス順（`kind` 順・`pubkey` 順など、`created_at` とは
    無関係）の先頭 N 件を返すため、`{kinds:[1], limit:20}` のような普通のタイムライン REQ で
    「任意の 20 件」が返っていた。全件取得後に `capEvents`（`created_at` 降順・id タイブレーク）で
    切り詰める形に変更し、`SqliteStorage` / relay 側の `maxEventsPerRequest` と順序規則を統一
    - トレードオフ: インデックス走査を N 件で打ち切れず、一致イベントをいったん全件
      materialize する（最適化は下記の未着手項目に切り出し）
  - `capEvents` が「一致件数 ≤ limit のときソートしない」早期 return を持っており、`limit` 付き
    クエリでも**返却順**が NIP-01（[nip-01.md](./nips/nip-01.md): "Newer events should appear first,
    and in the case of ties the event with the lowest id ... should be first"）を満たしていなかった。
    web-client の既定フィルタ `{ kinds: [1], limit: 100 }` は、キャッシュが 100 件未満の間
    常にこの経路を通るためタイムラインが古い順で表示され得た。早期 return を廃止し、
    件数によらず新しい順に整列するよう変更（`sortNewestFirst` として切り出し）
  - `since` / `until` の `0` が無視されていた: 共通判定 `eventMatchesFilter` と
    `SqliteStorage` のクエリ組み立てが truthy 判定（`if (until)`）だったため、`until: 0` が
    「指定なし＝全件」になっていた。`!== undefined` 判定に統一し、Dexie のインデックス絞り込みと
    そろえた（`isValidFilterShape` は `until: 0` を有効なフィルタとして通すため到達可能な経路）
  - `filter.limit` が整数とは限らない問題: フィルタ検証は `typeof === 'number'` しか見ないため
    `limit: 1.5` が通り、SQLite では `LIMIT 1.5` でクエリ全体が失敗して常に空応答になっていた。
    共通の `normalizeLimit`（小数は切り捨て・負値は 0・`NaN`/`Infinity` は「指定なし」）を追加し、
    両アダプタで共有
  - `since` / `until` の境界が一部分岐で排他だった: `dexie/query-builder.ts` の 3 分岐が
    Dexie `between()` の既定（上限排他）のままで、`created_at === until` のイベントが
    インデックス絞り込みの段階で落ちていた（最終判定の `eventMatchesFilter` は包含なので復活しない）。
    時間範囲の絞り込みを `betweenCreatedAt()` に集約し、全分岐で両端包含に統一。
    時間単独分岐にあった `until + 1` の補正も不要になったため削除
  - テスト: `dexie-storage.spec.ts` に limit（各インデックス経由での最新 N 件・返却順・
    一致件数 ≤ limit のケース・同時刻の id タイブレーク・`limit: 0` / 負値 / 小数 / `NaN`・
    フィルタ毎の適用）と境界包含（各インデックス分岐・`since: 0` / `until: 0`）を、
    `filter-utils.spec.ts` に `capEvents` / `normalizeLimit` / `eventMatchesFilter` の
    対応ケースを、`sqlite-storage.spec.ts` に同等の対になるケースを追加（計 20 件）。
    旧挙動を前提にしていた既存テスト 4 件は NIP-01 準拠の期待値へ修正

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
- [x] server の実永続化（オプトイン・挙動変更）
  - `packages/server/src/storage/sqlite-storage.ts` に Node 組み込み `node:sqlite`（`DatabaseSync`）による
    `SqliteStorage` を実装。`events` + `event_tags`（Dexie の multientry `*indexed_tags` 相当）
    スキーマで、`StorageAdapter` を optional の `deleteExpired` / `enforceLimit`（FIFO/LRU/LFU）まで完全実装。
    検証状態の 1→0 ダウングレード禁止・`getEvents` のみのアクセス追跡・タグインデックス 100 件キャップ
    （cache-relay の `getIndexedTags` を再利用）など Dexie 実装のセマンティクスをミラー
  - オプトインの口は `storageOptions.dbPath`（プログラム）と環境変数 `NOSTR_DB_PATH`（CLI）。未指定なら
    従来どおり fake-indexeddb（インメモリ）で挙動変更なし
  - 挙動変更: 永続モードでは `NostrRelayServer.stop()` がストレージを**クリアせず**、データを保持したまま
    DB を閉じる（既定モードは従来どおりクリア）。`index.ts` に SIGTERM ハンドラも追加
  - テスト: 単体（`sqlite-storage.spec.ts`＝dexie spec ミラー 62 件 + ファイル永続化・close 後フォールバック）、
    統合（`tests/integration/persistence.spec.ts`＝stop/再起動でのイベント生存と既定モードのクリア）、
    E2E（`e2e/tests/node/persistence.e2e.spec.ts`＝実子プロセスを `NOSTR_DB_PATH` 付きで SIGINT 再起動）
  - クエリ層はその後 Drizzle ORM（`drizzle-orm/node-sqlite`・1.0 RC 系）へ移行（エンジンは
    `node:sqlite` のまま）。クエリ組み立てが型安全になり、値の文字列連結を書ける余地が構造的に
    消えた。同期 API（`.run()`/`.all()`/`.get()`）のみ使用（トランザクション中の並行割り込み防止の
    前提条件）。DDL / PRAGMA / BEGIN IMMEDIATE は生 SQL のまま（drizzle-kit が node:sqlite 未対応の
    ため、テーブル定義と DDL の二重管理はコメントで明示）。ドライバは `createRequire` で遅延ロードし、
    ExperimentalWarning が永続化有効時のみ出る性質を維持。`saveEvent` の upsert は Dexie 実装と同じ
    「読み取り → UPDATE / INSERT 分岐」に分割済み（`ON CONFLICT` + `MAX()` を廃止）
  - 当初 Dexie 実装との差分として記録していた `until` 境界と `filter.limit` の 2 点は、
    Dexie 側のバグ（NIP-01 違反）と判断して修正済み。現在は両実装とも NIP-01 準拠で一致する
    （下記「Dexie ストレージの NIP-01 準拠フィルタ修正」を参照）
- [x] 同時接続・負荷下の正当性テスト（旧: 同時接続・スループットの性能テスト）
  - `packages/server/tests/integration/performance.spec.ts` として実装済み（#15）。多数の同時接続、単一クライアントからのバースト投入、複数クライアントからの並行投入、並行 REQ の全件応答（取りこぼし無し）を検証
  - 注: 実行時間に依存する閾値アサーションは意図的に行っておらず、スループット（件/秒）やレイテンシの測定・回帰検知はスコープ外。ベンチマークが必要になったら別項目として起こす

## 優先度: 中（設計書 `doc/cache-relay/cache-relay.md` 由来の未完了項目）

設計書の実装計画（フェーズ8・9）由来の項目。なお主要コンポーネント（イベント種別処理・検証・NIP-01/02・ストレージ・トランスポート・購読管理）は実装済みのため対象外。

- [x] E2E テストの実装（設計書フェーズ8）
  - [x] Node.js クライアント–サーバー E2E
    - `e2e/tests/node/server.e2e.spec.ts`（8 件）: 実サーバーを子プロセスとして起動し、
      実 WebSocket クライアントから EVENT/OK・REQ/EVENT/EOSE・CLOSE/CLOSED を検証
    - `e2e/tests/node/persistence.e2e.spec.ts`（2 件）: `NOSTR_DB_PATH` 付きで起動した
      子プロセスを SIGINT 再起動し、イベントが復元されることを検証
  - [x] ブラウザ クライアント–サーバー E2E
    - `e2e/tests/browser/relay-browser.e2e.spec.ts`（7 件）: Playwright（Chromium）で
      実ブラウザを起動し、`WebSocketServerEmulator` + IndexedDB のブラウザ内リレーを検証
  - CI ワークフロー `.github/workflows/e2e.yml` で Node / ブラウザとも実行（`npm run test:e2e`）
- [x] API ドキュメント / サンプルコードの整備（設計書フェーズ9）
  - `doc/api.md` に主要パッケージ（shared / cache-relay / server）の公開 API リファレンスを追加
  - `examples/node-relay-demo.mjs` に `@nostr-cache/cache-relay` を使った実行可能な E2E デモ（EVENT/OK・REQ/EVENT/EOSE・CLOSE/CLOSED）と `examples/README.md` を追加

## 優先度: 中（ストレージ実装の追随 — 2026-07 の棚卸しで追加）

- [ ] `DexieStorage` の `limit` クエリで早期打ち切りできる分岐を最適化する
  - 現状: NIP-01 準拠（最新 N 件・新しい順）を優先し、`limit` の有無にかかわらず一致行を
    全件 `toArray()` してから `rowToEvent` → 切り詰める。10 万件規模のキャッシュに
    `{kinds:[1], limit:20}` を投げると 10 万件ぶんのオブジェクト生成が走り、上限もない
  - `created_at` インデックスを使う分岐（時間範囲の 3 分岐 + 時間単独分岐）は走査順が
    `created_at` 昇順なので、`.filter(...)` の後に `.reverse().limit(n)` とすれば
    NIP-01 準拠のまま N 件で打ち切れる。それ以外の分岐（`kind` / `pubkey` / タグ index）は
    走査順が `created_at` と無関係なため全件走査が必要で、この最適化は使えない
  - 着手時は「どの分岐で早期打ち切りしたか」がテストから見えるようにすること
- [ ] 統合テストのポート採番を衝突しない方式にする
  - 現状は spec ファイルごとに `Math.floor(Math.random() * 10000) + <帯>` で採番しており
    （9000 / 20000 / 30000 / 40000 / 50000 番台に手で振り分けている）、同一帯の中で
    衝突すると `EADDRINUSE` でフレークする（実際に `performance.spec.ts` で発生）。
    ヘルスチェックが `port + 1` を使うため 1 サーバあたり 2 ポート消費する点にも注意
  - `WebSocketServer` にポート 0（OS 任せ）で起動して実ポートを返す口を用意し、
    テストはそれを使うのが本筋
- [ ] `DexieStorage` と `SqliteStorage` の等価性を担保する契約テストを用意する
  - `doc/api.md` は両実装のフィルタ解釈が一致すると宣言しているが、それを一括で保証する
    テストが無く、実装ごとの spec に同等ケースを手で並べている状態。実際、返却順・
    `until: 0`・小数 `limit` の 3 つの差分は既存テストでは検出できず、レビュー時の
    手動 probe で初めて露見した
  - 共有フィクスチャに対して同じフィルタ集合を両アダプタへ流し、結果を**順序込み**で
    比較する形が望ましい（`SqliteStorage` は server パッケージにあるため、テストの
    置き場所は server 側か新規の共有テストパッケージかを決める必要がある）
  - NIP-09 対応（2026-07）でも同じ複製が積み増しになった: `deleteEventsByIdsForPubkey` /
    `deleteEventsByAddress` / kind 5 の保持について、両 spec にほぼ同一のテストを
    手で並べている。しかも複製直後にヘルパが乖離し（Dexie 側だけ「d タグ無し」を
    作ろうとして到達不能なコードになっていた）、レビューで指摘されて初めて気づいた。
    契約テスト化は「あると良い」ではなく、複製が増えるたびに実際に事故が起きている

## 優先度: 中（NIP 対応の拡張 — 2026-07 の棚卸しで追加）

現在サポートしているのは NIP-01・NIP-02（kind 3 を replaceable として扱う範囲）・NIP-09。
以下はコードを読んで未対応であることを確認した項目で、いずれも「リレーとしての正しさ」
または「キャッシュとしての正しさ」に効く。

- [x] **NIP-09（イベント削除・kind 5）の対応**（2026-07）
  - NIP-01 の kind レンジ判定を `event/event-kind.ts`（依存なしの純関数）へ切り出し、
    `EventHandler` の private 判定メソッド 3 つと両ストレージアダプタで単一ソース化。
    NIP-09 の解析・適用は `event/deletion.ts`（`parseDeletionRequest` / `applyDeletionRequest` /
    座標判定 `matchesAddressIdentifier`）。仕様は [doc/nips/nip-09.md](./nips/nip-09.md)
  - `StorageAdapter` に 2 メソッドを追加（`DexieStorage` / `SqliteStorage` の両方で実装）:
    - `deleteEventsByIdsForPubkey(ids, pubkey)`（`e` タグ）: Dexie は主キー `anyOf` +
      filter、SQLite は `IN` + `pubkey =` + `kind != 5` を SQL で
    - `deleteEventsByAddress(address, until)`（`a` タグ）: Dexie は
      `[pubkey+kind+created_at]` インデックスの範囲削除、SQLite は select → JS 判定 → 削除
      （`d` タグはタグインデックスの 100 件キャップを避けるため `tags` JSON で照合）
  - 仕様上の 2 つの制約は**ストレージ側で保証**する。呼び出し側は保存済みの行（対象の
    pubkey / kind）を見られないため: ①`pubkey` が一致する行のみ削除、②kind 5 は決して
    削除しない（削除リクエストに対する削除リクエストは効果を持たない）
  - `a` タグは置換可能 / アドレサブル kind にのみ適用する。`1:<pubkey>:` のような通常 kind の
    座標を受理すると「この著者の kind 1 を全削除」になるため、解析段階で落とす
  - `a` タグの削除は `created_at <= 削除リクエストの created_at` の版のみ（リクエスト後に
    公開された版は残る）。`e` タグには時刻制約は無い
  - **削除は取り消せないため、kind 5 は `NONE` を含む全モードで同期検証**する。
    `NONE` は「送ったものを検証せず保存する」という意思表示であって「誰でも他人のデータを
    消してよい」ではない。未検証で受理すると、`validateEvents: false` のサーバに対して
    任意のクライアントが偽造 kind 5 で任意 pubkey のキャッシュを破壊できる。
    削除リクエスト 1 通あたり署名検証 1 回のコストで防げる。transport 経由
    （`EventHandler`）と in-process（`NostrCacheRelay.publishEvent`）の両方に適用
  - 同期検証を通ったイベントは `validated=1` で保存する（`saveOptions` を
    「設定されたモード」ではなく「実際に検証したか」で決めるよう変更）。LAZY/NONE で
    検証済みの kind 5 が遅延検証キューに再投入されたり `getValidationStatus` が
    `pending` を返したりしないようにするため
  - 削除リクエスト自体は保存し、配信し続ける（まだ受け取っていないクライアントのため／
    再受信時に再適用できるようにするため）。このため **kind 5 は TTL スイープの対象外・
    `storageMaxSize` 超過時は最後に退避**する（`storage/priority.ts` の
    `ALWAYS_RETAINED_KINDS`。`cachePriority` の設定によらず常に適用。退避の保護は
    best-effort で、他に退避対象が無ければ `maxSize` が優先される）。
    上流へのライトスルー転送も既存経路で機能する
  - 1 リクエストあたりの参照数は `e` / `a` それぞれ 1000 件で打ち切る
    （`MAX_DELETION_REFERENCES`）。座標 1 件につきストレージ 1 往復で、server では
    `node:sqlite` の同期 API のためイベントループがブロックされる。時間窓レート制限が
    未実装の現状、1 EVENT = O(1) ストレージ操作という性質を壊さないための上限
  - 上流から流れてきた kind 5（`MessageHandler.ingestUpstreamEvent` 経路）も
    `ingestEvent` → `EventHandler.handleEvent` を通るため同じ処理が適用される
  - `StorageAdapter` への 2 メソッド追加は**必須メンバー**（`deleteExpired` / `enforceLimit`
    のような optional ではない）なので、独自アダプタ実装に対しては破壊的変更。
    `doc/api.md` に注記済み
  - テスト: `event/deletion.spec.ts`（19 件）、`event-handler.spec.ts` / `message-handler.spec.ts` /
    `nostr-cache-relay.spec.ts` への追加、`dexie-storage.spec.ts` / `sqlite-storage.spec.ts` に
    対になるストレージテスト（各 17 件。NIP-09 の削除 + kind 5 の保持）、
    `packages/server/tests/integration/nip09.spec.ts`（実 WebSocket + 実署名で 9 件）
- [ ] **削除済みイベントの「復活」防止**（NIP-09 の残課題）
  - 現状: 削除リクエストを適用した後に、同じイベントが別経路から再び届くと再保存される。
    具体的には、削除を反映していない上流リレーからのリードスルー充填、クライアントの再送
  - 対策の方向: 保存時に「その id（または座標 + `created_at`）を対象とする kind 5 が
    同一 pubkey から保存済みか」を引く。`e` タグはタグインデックス済みなので
    `{kinds:[5], authors:[pubkey], '#e':[id]}` 相当で引けるが、**保存のホットパスに
    クエリが 1 回増える**うえ、`getEvents` は LRU/LFU のアクセス追跡を伴うため
    そのままは使えない（追跡しない専用の参照が要る）
  - 着手時はコストを測ってから入れること。現実には「クライアントが全リレーへ kind 5 を
    ブロードキャストする」運用で大半が防げるため、優先度は本体実装より下
- [ ] **NIP-40（`expiration` タグ）の対応**
  - 現状: `expiration` タグは完全に無視され、期限切れイベントも保存・配信され続ける
  - `ttl` / `ExpiryReaper`（`cached_at` 基準の定期スイープ）という土台があるため、
    イベント個別の期限として同じスイープに載せられる位置にある
- [ ] **NIP-11（リレー情報ドキュメント）の対応**
  - 現状: 未対応。`Accept: application/nostr+json` に対する応答が無く、クライアントが
    リレーの対応 NIP や制限値（`max_subscriptions` / `max_limit` など）を知る手段がない
  - server には既にヘルスチェック用の HTTP ポート（`health-server.ts`）があるため、
    そこに相乗りさせれば低コストで実現できる。「サーバで実行すれば普通のリレー」を
    名乗る上では実質必須
- [ ] `NostrCacheRelay.publishEvent()` を `EventHandler` 経由に統一する
  - NIP-09 実装時に判明した既存の不整合。`publishEvent()` は `storage.saveEvent()` を直接
    呼ぶため、transport 経由 `EVENT` では `EventHandler` が行っているイベント種別の処理を
    まるごと飛ばしている。**in-process で kind 0 / 3 / 10000番台を publish しても古い版が
    削除されず**（replaceable にならない）、30000番台の d タグ置換も効かず、
    ephemeral（20000番台）も保存されてしまう
  - NIP-09 については同じ穴を避けるため `publishEvent()` にも削除適用を明示的に追加したが、
    種別処理そのものを二重に持つのは筋が悪い。`EventHandler.handleEvent()` に寄せて
    ローカル購読通知だけを `publishEvent()` 側に残すのが本筋
  - 破壊的変更ではないが、in-process 経路の**挙動が変わる**（上記のとおり現状が間違っている）
    ため、単独のタスクとして切り出す
- [ ] `RelayEventHandler` に `subscriptionId` を伝える（既知の制約の解消）
  - `emit('event')` の実装時に別タスク化した項目。`RelayEventHandler` がイベントのみを
    受け取る型のため、in-process の `subscribe()` を複数使うとどの購読由来のイベントか
    判別できない（`doc/api.md` にも既知の制約として記載）
  - 公開 API の破壊的変更になるため、ハンドラのシグネチャ変更（`(event, subscriptionId)`）で
    進めるかを決めてから着手する

## 優先度: 高（公開デモと埋め込み — 2026-07 に追加）

- [x] **GitHub Pages で公開する透過キャッシュのデモサイト**（`packages/demo-site`）
  - Svelte 5 + Vite の SPA（`base: '/nostr-cache/'`）。上流リレー / kinds / limit を UI から
    設定でき、`packages/web-client` のように上流リレーをソースへハードコードする必要がない
  - キャッシュ由来の可視化: 各イベントに `cache` / `upstream` バッジ。ライブカウンタ
    （キャッシュ配信数 / 上流取得数 / 上流接続数 / キャッシュ保存数）
  - コールド / ウォーム計測: `storage.clear()` 後の 1 回目と 2 回目を比較し、
    **初回イベントまでの時間**を並べて表示（EOSE はリードスルーが常に上流へ REQ を
    転送するため縮まない。これは仕様どおりで、UI にもその旨を明記した）
  - `.github/workflows/pages.yml` で `main` への push 時に自動デプロイ
    （要初回設定: Settings → Pages → Source = GitHub Actions）
- [x] **埋め込み可能なタイムラインウィジェット**（`packages/timeline-embed`）
  - iframe と Web Component の 2 形態。**実装は 1 つ**で、`dist/embed/index.html` は
    `dist/nostr-timeline.js` を読んで `<nostr-timeline>` を置くだけの薄いページ。
    iframe 内では emulator が iframe 自身の `globalThis` を差し替えるため、
    インページ方式の実装がそのまま隔離モードとしても動く（別コードパスなし）
  - 自己完結した IIFE 1 ファイル（約 232 KB / gzip 約 78 KB）。スタイルは Shadow DOM に
    インライン展開されるため別途 CSS 不要。CSS カスタムプロパティでテーマ調整可能
  - `relay-host.ts`: ページ共有リレーのシングルトン + 参照カウント。emulator が
    `globalThis.WebSocket` を差し替える以上、複数ウィジェットが各自エミュレータを
    起動すると 2 つ目が**差し替え済みの WebSocket を "original" として保持**して
    復元順で壊れるため。購読の分離は各ウィジェットが `new WebSocket(interceptUrl)` で
    自分専用の接続を張ることで得ている（emulator の `Map<clientId, socket>` を利用）。
    これにより in-process `subscribe()` の「`RelayEventHandler` が subscriptionId を
    運べない」既知の制約も回避している
  - 設定衝突は「最初に mount されたウィジェットの設定が勝ち、以降は警告して共有」。
    1 ページから同じ上流へ何本も接続を張らないための意図的な制約
- [x] **cache-relay を無改変での上流トラフィック計測**
  - `NostrRelayOptions.upstreamPool`（公開済みの注入口。`upstreamRelays` より優先）を使い、
    `UpstreamPool` を実装した `InstrumentedUpstreamPool` デコレータで `UpstreamRelayPool` を包む
  - 由来の分類は「上流から来た id の集合」との照合。上流イベントはプールの `onEvent` →
    リレーの検証・保存 → クライアント配信の順に流れるため、クライアント到達時には必ず
    集合に入っている。ローカルキャッシュ由来は上流より先に配信され、かつ
    `UpstreamCoordinator.markDelivered` が dedup 集合に播種するので上流エコーで再配信されない
  - 分類は配信時点で確定し後から書き換えない（`cache` と表示したものが後で `upstream` に
    変わらない）
  - 検証済み: `e2e/tests/browser/timeline-embed.e2e.spec.ts`（6 件）で、実 Chromium +
    実 IndexedDB + モック上流リレーに対し「初回は `upstream` バッジ → リロード後は同じ
    イベントが `cache` バッジ」「ウォームでも上流への REQ 転送は続く」を確認
- [x] https ページからの `ws://` インターセプトの検証（自動テスト化済み）
  - Pages は https 配信のため、`new WebSocket('ws://nostr-cache.invalid')` が混在コンテンツで
    弾かれる懸念があった。emulator は差し替えたコンストラクタで `EmulatedWebSocket`
    （ネイティブ非継承）を返すためブラウザのチェックに到達せず、**https オリジンでも
    インターセプトが成立する**
  - 回帰ガード: `e2e/tests/browser/embed-https.e2e.spec.ts`（3 件）。
    `e2e/src/self-signed-cert.ts` が実行時に openssl で自己署名証明書を生成し
    （鍵はコミットしない）、埋め込みページを https で、モック上流を `wss://` で配信して
    実 Chromium から検証する。openssl が無い環境では skip する
  - 上流リレーの側は https の混在コンテンツ制約をそのまま受ける（上流接続は差し替え前の
    実 WebSocket を使うため）。`wss://` 以外は `parseRelays` が警告付きで除外する

## 優先度: 低（整備）

- [ ] `packages/web-client` の lib モジュールを `timeline-embed` へ寄せて重複を解消する
  - `relay-connection.ts` / `timeline-utils.ts` / `validation-status.ts` は
    web-client と timeline-embed に同等のコードが 2 箇所ある（timeline-embed 追加時に
    web-client を壊さないよう複製した）
  - timeline-embed が実質の共通ライブラリ層になっているので、web-client から
    `@nostr-cache/timeline-embed` を参照する形に寄せるか、共通パッケージへ切り出すかを決める
  - 併せて、web-client 自体を残すのか（`demo-site` と役割が重複する）を判断する

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
