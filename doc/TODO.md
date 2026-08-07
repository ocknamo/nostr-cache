# TODO リスト

残作業の一覧。**このファイルは未着手の課題だけを追う**。完了した作業の詳細な経緯は
git の履歴と各設計書（[doc/](.) 以下）にあるので、ここでは末尾に見出しだけを残す。

## 現状（2026-07）

リレーコア（イベント種別処理・検証・NIP-01/02/09・ストレージ・購読管理）は実装済みで、
モノレポ全体の build / typecheck / test は CI で緑。ブラウザ内ローカルリレーへの
エンドツーエンド配線、上流リレーへの透過キャッシュ化（リードスルー / ライトスルー）、
公開デモ（GitHub Pages）、埋め込みウィジェットも実装済み。
対応 NIP は NIP-01・NIP-02（kind 3 を replaceable として扱う範囲）・NIP-09。

| パッケージ | 役割 |
|---|---|
| shared | 共有型・ユーティリティ |
| cache-relay | ブラウザ内 Nostr リレー本体（キャッシュの中核） |
| server | Node.js サーバー（既定 fake-indexeddb / `NOSTR_DB_PATH` で `node:sqlite` 永続化） |
| web-client | Svelte 製の開発用クライアント（ローカルリレー配線のデモ） |
| timeline-embed | 埋め込みウィジェット + 共通ライブラリ層 |
| demo-site | GitHub Pages 公開用デモ |

## 優先度: 中（NIP-01 の版比較の残課題）

replaceable / addressable の版比較（NIP-01「最新の1件だけを保持する」）を入れた際に
残した課題。いずれも比較そのものは正しく動くが、周辺の穴。

- [ ] **`created_at` の未来方向の上限チェックが無い**
  - 現状: 遠未来の `created_at` を持つイベントは常に版比較に勝つ。既定の
    `IMMEDIATELY` では署名検証があるため他人になりすました版は作れないが、
    **`validateEventsType: 'NONE'`（server の `relay.validateEvents: false`）では、
    未検証の遠未来イベントが1通入ると、その座標の正当な更新が以後すべて落ち続ける**
    （`LAZY` は背景検証が不正イベントを削除するまでの一時的な影響）
  - 版比較を入れる前は「古い版が無条件に上書き」だったため次の正当な版で自己修復して
    いた。塞いだのは版比較なので、対で入れるべきだったのはこの上限チェック
  - 対応: 一般的なリレーと同様に「now + 許容幅」を超える `created_at` を
    `invalid:` で拒否する（許容幅は設定可能にする）。検証状態（`validated`）で
    比較対象を絞る案は、`NONE` では比較が丸ごと無効化され、`LAZY` では pending の
    新しい版が無視されて元のバグに戻るため不可
- [ ] **superseded 時に鮮度ウィンドウが再武装されない**
  - 現状: 上流が「キャッシュより古い版」を返したとき、そのイベントは保存しないので
    `cached_at` が更新されない。`FreshnessGate.markRevalidated` は既に配信済みの
    id（`onDuplicate`）でしか発火しないため、**キャッシュが上流より新しい座標では
    窓が失効したまま、以後の REQ が毎回上流へ抜ける**
  - 上流が古い版しか持たないなら「キャッシュの版で十分新鮮」と判断してよいので、
    superseded 時に現行版の `cached_at` を打ち直すのが筋。`IngestResult` に現行版の
    id を載せて coordinator から `FreshnessGate` に渡す形になる
- [ ] **複数版が保存されている場合に REQ 応答を最新1件へ畳んでいない**
  - NIP-01: 「複数の版を持っていても REQ には最新のものだけを返すべき（SHOULD）」
  - 版比較を通る経路では版は1つに収束するが、`publishEvent()` 経由（下記「API の
    一貫性」の項目）や、比較導入前に書かれた行では複数版が同居しうる
- [ ] **`d` タグの無いアドレサブルイベントの扱いが揃っていない**
  - 現状: `handleAddressableEvent` は `d` タグが無いと保存しないが、`handleEvent` は
    `success: true` を返すため**保存されないのに購読者へ配信され上流へも転送される**
  - 一方、座標解決（`addressOf` / `matchesAddressIdentifier`）と適合性テストは NIP-01 に
    従い「`d` 無し = 空識別子」で揃っている。保存側も空識別子として扱うのが筋

## 優先度: 中（NIP 対応の拡張）

いずれも「リレーとしての正しさ」または「キャッシュとしての正しさ」に効く。

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

## 優先度: 中（API の一貫性）

- [ ] `NostrCacheRelay.publishEvent()` を `EventHandler` 経由に統一する
  - NIP-09 実装時に判明した既存の不整合。`publishEvent()` は `storage.saveEvent()` を直接
    呼ぶため、transport 経由 `EVENT` では `EventHandler` が行っているイベント種別の処理を
    まるごと飛ばしている。**in-process で kind 0 / 3 / 10000番台を publish しても古い版が
    削除されず**（replaceable にならない）、30000番台の d タグ置換も効かず、
    ephemeral（20000番台）も保存されてしまう。NIP-01 の版比較（古い版を保存しない）も
    同じ理由で通らないため、**in-process 経路では古い版を publish すると併存する**
  - NIP-09 については同じ穴を避けるため `publishEvent()` にも削除適用を明示的に追加したが、
    種別処理そのものを二重に持つのは筋が悪い。`EventHandler.handleEvent()` に寄せて
    ローカル購読通知だけを `publishEvent()` 側に残すのが本筋
  - 破壊的変更ではないが、in-process 経路の**挙動が変わる**（上記のとおり現状が間違っている）
    ため、単独のタスクとして切り出す
- [ ] `RelayEventHandler` に `subscriptionId` を伝える（既知の制約の解消）
  - `RelayEventHandler` がイベントのみを受け取る型のため、in-process の `subscribe()` を
    複数使うとどの購読由来のイベントか判別できない（`doc/api.md` にも既知の制約として記載）
  - 公開 API の破壊的変更になるため、ハンドラのシグネチャ変更（`(event, subscriptionId)`）で
    進めるかを決めてから着手する

## 優先度: 中（server）

- [ ] 時間窓ベースのレート制限（メッセージ / EVENT 投稿の頻度制限）の実装とテスト
  - 現状はクライアント毎の購読数上限（`maxSubscriptions`）のみで、単位時間あたりの
    リクエスト頻度を制限する仕組み（スロットリング）は `message-handler` に存在しない

## 優先度: 中（ストレージ / テスト基盤）

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

## 優先度: 低（整備）

- [ ] `packages/web-client` を残すかを判断する（`demo-site` と役割が重複する）
  - lib モジュールの重複は解消済み（web-client は `@nostr-cache/timeline-embed/lib` を参照）。
    残っているのは「開発用クライアントを 2 つ維持するか」という判断だけ
- [ ] 署名検証をワーカーへ逃がすか検討する
  - `@rx-nostr/crypto` は `startVerificationServiceHost` /
    `createVerificationServiceClient`（検証を Worker 側で回す仕組み）を公開している。
    `LAZY` 検証をメインスレッドから外せる可能性がある
  - これは移行で新しく生えた API ではなく旧 `rx-nostr-crypto@3.1.3` にもあったもの。
    着手するなら実際にメインスレッドの占有が問題になっているかの計測が先
- [ ] フォローリスト由来のタイムライン表示（NIP-02）をクライアントに出すか決める
  - 旧 Angular 製 POC の設計書に「特定ユーザーのフォローリスト（kind 3）を取得し、
    フォロー中の pubkey の kind 1 を購読する」拡張案があった。リレー側は kind 3 を
    replaceable として扱えるため下地はあるが、クライアント（web-client /
    timeline-embed）側は未実装で、`{ kinds: [1], authors: [...] }` を手で入れる必要がある
  - 実装するなら timeline-embed の `timeline-config.ts` に「pubkey を起点に
    フォローリストを引いて authors を展開する」経路を足す形になる

## 完了済み

詳細は git 履歴と各設計書を参照。

**目的の本丸**
- Web クライアントとローカルリレーのエンドツーエンド配線（Svelte 製 web-client +
  `WebSocketServerEmulator` + IndexedDB）。エミュレータの実ネットワーク接続・
  単一接続保持・URL 固定の設計上の問題もあわせて解消
- 上流リレーへの透過キャッシュ化（リードスルー / ライトスルー）。
  `cache-relay/src/upstream/` — 設計は [cache-relay/upstream.md](./cache-relay/upstream.md)
- 鮮度ウィンドウ `upstreamFreshness`（HTTP の `max-age` 相当。replaceable のみ）
- GitHub Pages の公開デモサイト（`packages/demo-site`）と埋め込みウィジェット
  （`packages/timeline-embed`。iframe / Web Component の 2 形態）
- cache-relay を無改変での上流トラフィック計測（`InstrumentedUpstreamPool`）
- 上流接続層を rx-nostr へ寄せて重複実装を解消（`upstream-connection.ts` を削除。
  接続・再接続・購読再確立はライブラリ側へ。EOSE 集約だけが自前で残る）。
  移行後の設計は [cache-relay/upstream.md](./cache-relay/upstream.md) 第2.1節
- https ページからの `ws://` インターセプトの検証（自動テスト化）

**cache-relay コア**
- `subscribe()` / `unsubscribe()` の本実装と `emit('event'|'eose')` の実データ化
- 未実装オプションをすべて実装: `maxEventsPerRequest` / `ttl`（`cached_at` 基準の
  定期スイープ）/ 遅延バリデーション（`LAZY`）と検証状態の DB 永続化 /
  `storageMaxSize` + `cacheStrategy`（FIFO / LRU / LFU）/ `cachePriority`
- フィルタマッチロジックの重複（`subscription-manager` と `utils/filter-utils`）を共通化
- Dexie ストレージの NIP-01 準拠フィルタ修正（`limit` が「最新 N 件」でなかった /
  返却順が新しい順でなかった / `since`・`until` の `0` が無視されていた /
  小数 `limit` / 境界が一部分岐で排他だった）
- NIP-09（イベント削除・kind 5）の対応。kind 5 は全モードで同期検証し、
  TTL スイープ対象外・退避は最後
- replaceable / addressable の版比較（NIP-01「最新の1件だけを保持する」）。
  保存前に既存版と `created_at` を比較し、古い版は保存も配信も上流転送もしない
  （同値は id の辞書順）。座標の現行版は `StorageAdapter.getCurrentVersion` で引く

**server**
- ビルド型エラーの修正と CI 復旧、`tsc --noEmit` による typecheck の CI 組み込み
- `getConnectionCount()` / `getEventCount()` の実装、`/health` エンドポイント
- NIP-01 準拠の統合テスト拡充、同時接続・負荷下の正当性テスト
- 実永続化（オプトイン）: `node:sqlite` + Drizzle ORM の `SqliteStorage`。
  口は `storageOptions.dbPath` / 環境変数 `NOSTR_DB_PATH`

**テスト / 基盤**
- E2E テスト（Node.js / ブラウザ）と CI ワークフロー `.github/workflows/e2e.yml`
- `DexieStorage` と `SqliteStorage` の等価性を担保する契約テスト
  （`cache-relay/src/test/storage-conformance.ts`。両アダプタが同一の適合性テストを実行する）
- web-client / timeline-embed の重複した lib モジュールの共通化
  （`@nostr-cache/timeline-embed/lib`）
- shared パッケージのテスト追加、CI の `lint:check` を全パッケージ対象に拡大
- tsconfig の deprecation 対応と TypeScript 6 系への引き上げ
- 署名・検証を deprecated な `rx-nostr-crypto@3.1.3` から後継の
  `@rx-nostr/crypto@3.1.6` へ移行（公開 API は同一。`@noble/curves` などが
  メジャーアップするが、バンドルは微減で署名の相互検証も一致）
- API ドキュメント（[api.md](./api.md)）と実行可能なサンプル（[examples/](../examples/README.md)）

**廃棄**
- Angular 製 web-client（POC）の廃棄。以降は Svelte 製で作り直し
