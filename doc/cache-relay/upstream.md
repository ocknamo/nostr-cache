# 上流リレー透過キャッシュ（リードスルー / ライトスルー）の設計仕様書

## 1. 概要

`upstream/` レイヤーは、ローカルの `NostrCacheRelay` を「上流の実リレー群の手前に
透過的に挟まるキャッシュ」に拡張する。プロジェクトの本来の目的
（[doc/concept.md](../concept.md) 第3節）に直結する中核機能である。

- **リードスルー**: `REQ` を受け取ると、ローカルの保存済みイベントを即座に返しつつ、
  同じフィルタを上流リレー群へも転送する。上流から得たイベントは重複排除したうえで
  ローカルストレージへ充填（backfill）し、クライアントへ配信する。
- **ライトスルー**: `EVENT`（投稿）をローカルへ保存すると同時に、上流リレー群へも
  転送する（fire-and-forget）。

この機能は**オプトイン**である。`NostrRelayOptions.upstreamRelays` を指定しない限り、
リレーは従来どおり「自分が保存済みのイベントのみ返す独立リレー」として動作する。

## 2. アーキテクチャ

```
クライアント ─ transport ─ MessageHandler ──┬─ EventHandler ─ StorageAdapter
                                            │
                     NostrCacheRelay ─── UpstreamCoordinator（購読対応表 / 重複排除 /
                                            │                  EOSE 集約 / backfill）
                                            └─ UpstreamRelayPool（複数リレーへのファンアウト）
                                                  └─ UpstreamConnection × N（1リレー1ソケット、
                                                        再接続・購読再確立）
```

`upstream/` に 3 つのクラスと型定義を新設する。

### 2.1 UpstreamConnection（`upstream/upstream-connection.ts`）

1 つの上流リレーとの WebSocket 接続を担う。

- 接続タイムアウト、切断/エラー時の**指数バックオフ再接続**を所有する。
- 再接続に成功したら、その接続で開いていた全購読の `REQ` を自動で再送する
  （アクティブ購読を内部の Map に保持）。
- 受信メッセージのうち `EVENT` / `EOSE` のみをコールバックで上げる。
  `OK` / `NOTICE` / `CLOSED` は debug ログのみ。
- 標準の `WebSocket` API しか使わないため、Node.js（Node 22 のネイティブ
  `globalThis.WebSocket`）とブラウザの両方で動作する。**`ws` パッケージには依存しない**。

### 2.2 UpstreamRelayPool（`upstream/upstream-relay-pool.ts`）

複数の `UpstreamConnection` を束ね、`REQ` / `EVENT` / `CLOSE` を全リレーへ
ファンアウトする。中心的な役割は **EOSE の集約**である。

- `openSubscription` 時点で**接続確立済みだったリレー集合**を記録し、それら全員が
  `EOSE` を返したときに 1 回だけ `onEose` を発火する（0 台なら次の tick で即発火）。
- 後から接続（再接続含む）したリレーは集約対象に加えない。落ちているリレーによって
  クライアントの EOSE が永遠に遅延する事故を防ぐため。
- `maxRelays`（既定 `DEFAULT_MAX_CONCURRENT_RELAYS`）を超える URL は警告して無視する。
  URL は重複排除する。

### 2.3 UpstreamCoordinator（`upstream/upstream-coordinator.ts`）

リレー内部と上流プールの橋渡し。オーケストレーションの中心。

- **購読対応表**: `(clientId, subscriptionId) ⇄ upstreamSubId` の 1:1 対応。
  `upstreamSubId` は短い生成 id（`up1`, `up2`, …）。クライアント購読 id との連結は
  NIP-01 の「64 文字以内」を超えうるため採用せず、対応表で相互参照する。
- **重複排除**: 購読ごとに送信済み `event.id` の集合を保持。REQ 応答でローカルから
  送った id を初期投入し、上流由来イベントはライブ配信中も照合する。集合は上限
  （既定 10,000 件）で頭打ちにし、超過時は挿入順に古い id から破棄する。
- **backfill**: 上流イベントは `MessageHandler.ingestUpstreamEvent` 経由で取り込む。
  これにより検証モード（`validateEventsType`）・replaceable/addressable の置換・
  ephemeral の非保存・遅延検証・ストレージ上限退避が、通常の EVENT 入口と同じ挙動で
  適用される。取り込みは**購読単位で直列化**し、replaceable の置換競合を防ぐ。
- **EOSE の保留**: クライアントへの `EOSE` は、上流の集約 EOSE か
  タイムアウト（既定 `DEFAULT_SUBSCRIPTION_TIMEOUT`）の早い方まで保留してから送る。
- **クリーンアップ**: `CLOSE`・購読上書き・クライアント切断時に、対応する上流購読を閉じる。

## 3. メッセージフロー

### EVENT（ライトスルー）

```
client ── ["EVENT", ev] ──▶ MessageHandler.handleEventMessage
  ├─ ingestEvent（検証 → EventHandler.handleEvent → lazy enqueue → enforceLimit）
  ├─ client ◀── ["OK", id, true]（ローカル保存の成否で即応答。上流は待たない）
  ├─ ローカル購読へブロードキャスト（従来どおり）
  └─ coordinator.publish(ev) → pool: 接続済み全上流へ ["EVENT", ev]
       （fire-and-forget。上流の OK は debug ログのみ。切断中リレーへはドロップ）
```

### REQ（リードスルー）

```
client ── ["REQ", subId, ...filters] ──▶ handleReqMessage
  ├─ （同 subId の旧上流購読があれば先に CLOSE）
  ├─ SubscriptionManager 登録
  ├─ storage.getEvents → capEvents → client へ ["EVENT", subId, ev]×N（id を sentIds に記録）
  └─ coordinator.openForSubscription(clientId, subId, filters, sentIds)
       ├─ upstreamSubId 採番・対応表登録・EOSE タイマー開始
       └─ pool.openSubscription → 各上流へ ["REQ", upstreamSubId, ...filters]

上流 ── ["EVENT", upstreamSubId, ev] ──▶ coordinator
  ├─ 対応表を引く（CLOSE 済みなら破棄）／ sentIds 重複なら破棄
  ├─ ingest（検証・保存・置換・lazy・enforceLimit を通常経路と同一に適用）
  └─ 成功時: sentIds 追加 → client へ ["EVENT", subId, ev]（EOSE 前後を問わず配信）

全上流 EOSE or upstreamEoseTimeout ──▶ client ◀── ["EOSE", subId]（1 回だけ）
以降も購読は上流で開いたまま。ライブイベントが透過的に流れ続ける
```

### REQ（鮮度ウィンドウでスキップされる場合）

```
client ── ["REQ", subId, {"kinds":[0],"authors":[pk]}] ──▶ handleReqMessage
  ├─ storage.getEvents → capEvents → client へ ["EVENT", subId, ev]×N
  ├─ FreshnessGate.filtersForUpstream(filters, 送信したイベント)
  │    ├─ 適用対象フィルタなし / getCachedAt 非対応 / エラー → フィルタをそのまま返す
  │    └─ storage.getCachedAt → 窓の内側の座標集合を作り、充足フィルタを除外
  └─ 残ったフィルタが 0 件 → 上流購読を開かず client ◀── ["EOSE", subId] を即送出
     残ったフィルタが 1 件以上 → その分だけを coordinator.openForSubscription へ
```

### CLOSE / 切断

```
client ── ["CLOSE", subId] ──▶ handleCloseMessage
  ├─ client ◀── ["CLOSED", subId]、SubscriptionManager から削除
  └─ coordinator.closeForSubscription → 各上流へ ["CLOSE", upstreamSubId]、対応表・タイマー破棄

transport.onDisconnect(clientId) ──▶ MessageHandler.handleClientDisconnect
  ├─ subscriptionManager.removeAllSubscriptions(clientId)
  └─ coordinator.closeAllForClient(clientId)

relay.disconnect() ──▶ coordinator.stop()（全 EOSE タイマー解除 + pool.stop = 全ソケット close）
```

## 4. オプション（`NostrRelayOptions`）

| オプション | 既定 | 説明 |
|---|---|---|
| `upstreamRelays?: string[]` | なし | 上流リレー URL。指定時のみリード/ライトスルーが有効 |
| `upstreamEoseTimeout?: number` | `DEFAULT_SUBSCRIPTION_TIMEOUT`（3000ms） | クライアント EOSE を上流 EOSE まで待つ上限 |
| `upstreamConnectionTimeout?: number` | `DEFAULT_CONNECTION_TIMEOUT`（5000ms） | 上流への接続タイムアウト |
| `upstreamFreshness?: Record<number, number>` | なし | 鮮度ウィンドウ。kind → 「その kind のキャッシュを新鮮とみなす秒数」（第5節参照）。replaceable な kind のみ指定可 |
| `upstreamPool?: UpstreamPool` | なし | テスト・高度用途。プール実装を差し替える（`upstreamRelays` より優先） |

`packages/server` では `NostrRelayServerOptions.relay.upstreamRelays` 等として素通しする。
`packages/web-client` の `startLocalRelay(url, { upstreamRelays })` からも指定できる。

## 5. 鮮度ウィンドウ（cache-first read-through）

既定のリードスルーは、キャッシュのヒット状況に関係なく **毎回** 上流へ REQ を転送する。
kind 0（プロフィール）のような replaceable イベントは (pubkey, kind) ごとに最新1件しか
存在せず内容もほとんど変化しないため、これは上流トラフィックと EOSE レイテンシの
両面で無駄になる（EOSE は上流の集約 EOSE か `upstreamEoseTimeout` まで保留される）。

`upstreamFreshness` は HTTP キャッシュの `max-age` に相当する仕組みで、
**「キャッシュ投入から N 秒以内の replaceable イベントは十分新鮮とみなし、上流に
問い合わせない」**。実装は `upstream/freshness.ts`（判定は純粋関数、ストレージ
アクセスを伴うラッパが `FreshnessGate`）。

```ts
const relay = new NostrCacheRelay(storage, transport, {
  upstreamRelays: ['wss://nos.lol'],
  upstreamFreshness: { 0: 3600, 3: 600 }, // プロフィールは1時間、フォローリストは10分
});
```

### 判定アルゴリズム

REQ のフィルタごとに独立に判定する。

**適用条件** — 以下を **すべて** 満たすフィルタだけがスキップ判定に進む。1つでも
欠ければそのフィルタは無条件に上流へ転送される。

- `kinds` が非空で、**全 kind が replaceable かつ全 kind に窓が設定済み**。
  通常 kind が1つ混ざるだけで結果集合は非有界になり「キャッシュが全部持っている」が
  判定不能になる
- `authors` が非空。期待する座標は `kinds × authors` なので、authors が無いと
  列挙できない
- `ids` を持たない。id 指定は別の（より強い）ショートサーキットの領域
- `since` / `until` を持たない。`until` は「その時点での最新版」を要求しており、
  キャッシュが持つ最新版とは別物になりうる
- `#` で始まるタグ条件を持たない

`limit` は許容される。切り詰めで座標が充足されなくなるだけなので、結果は保守側に倒れる。

**期待座標集合** = `kinds × authors`（キーは `<kind>:<pubkey>`。replaceable は
d タグを使わないので座標に入らない）。

**充足座標集合** = 「その REQ で実際にクライアントへ送ったイベント」のうち、
`storage.getCachedAt` の返す `cached_at` が `now - 窓*1000` 以降のもの。
`limit` / `maxEventsPerRequest` で切り捨てられたイベントは送っていないので数えない。

期待集合が充足集合に包含されればそのフィルタを上流へ送らない。**全フィルタが
スキップされた場合は上流購読を開かず、その場で EOSE を返す。**

### フェイルオープン

`getCachedAt` 未実装のアダプタ、ストレージエラー、判定不能はすべて
「従来どおり上流へ転送」に倒す。証明できない鮮度でキャッシュを返すことだけが、
透過性を静かに壊す唯一の失敗モードだからである。

### トレードオフ

- **スキップされた購読はライブ更新を受け取らない**。上流購読を持たないため、
  その購読が生きている間の新着は届かない。HTTP キャッシュと同じ
  「次回のリクエストで再検証する」セマンティクスになる
- 窓の内側では上流の更新が見えない。`ttl` と違い、窓が切れてもキャッシュは
  削除されず、次回 REQ で上流に問い合わせて再検証される（replaceable なので
  新しい版が来れば置換される）
- 判定コストは REQ ごとに `getCachedAt` 1回（主キー検索、アクセス追跡なし）。
  適用対象フィルタが無い場合はストレージに触らない

## 6. 設計上の判断とトレードオフ

- **EOSE を保留する**理由: web-client のような「EOSE で描画確定」型のワンショット
  クライアントに対する透過性を優先。NIP-01 上、EOSE 後のイベント配信も合法なので、
  タイムアウト超過後に届いた上流イベントもそのまま配信すれば取りこぼしはない。
- **ライトスルーは fire-and-forget**: クライアントへの `OK` はローカル保存の成否で
  即座に返し、上流の結果を待たない。応答レイテンシを上流に依存させないため。
- **上流イベントは当該購読の持ち主のみへ配信**する（`handleEvent` の matches 全配信は
  使わない）。各クライアント購読が自分の上流購読を持つため、全配信は二重配信になる。
  他の購読はストレージ充填の恩恵を次回 REQ で受ける。
- **WebSocket は遅延ファクトリで取得**する。ブラウザではエミュレータが
  `globalThis.WebSocket` を差し替えるため、上流には差し替え前のオリジナル
  （`TransportAdapter.getOriginalWebSocket()`）を使う。これにより、実リレー URL を
  横取りしつつ同じ URL を上流に指定した場合の**自己接続ループを構造的に防ぐ**。
  評価は接続時（構築時ではなく）なので、`connect()` 前後どちらでも安全。

## 7. 既知の制限（将来課題）

- **再送キューは持たない**: 上流が全滅している間に投稿された EVENT は転送されず失われる
  （クライアントへの `OK` は `true` で返る）。オフライン中の投稿を後で送る仕組みは未実装。
- **購読多重化はしない**: クライアント購読 1 に対し上流購読 1（1:1）。同一フィルタの
  複数購読をまとめて 1 本の上流購読にする最適化は行わない。
- **重複排除はメモリ内・上限つき**: 上限を超えると古い id を破棄するため、極端に長寿命で
  大量のイベントが流れる購読では、ごく稀に既送イベントの再配信が起こりうる。
- **再接続時の再送で TTL が延びる**: 再接続で同じイベントが再送されると、`DexieStorage`
  の `put` 冪等性で重複保存は防げるが、`cached_at` がリセットされ TTL が延びる。
- **再接続は無制限リトライ**: 切断された上流へは指数バックオフ（上限 60 秒）で
  `close()` されるまで再接続を試み続ける。到達不能な URL を誤設定すると再接続ログが
  出続ける。リトライ回数上限やサーキットブレーカは未実装。
- **上流 AUTH（NIP-42）などは未対応**: 認証が必要な上流リレーには接続できない。
- **鮮度ウィンドウは addressable 未対応**: 30000–39999 は座標に `d` タグが入るため、
  フィルタに `#d` がなければ期待集合を列挙できない。今回は replaceable
  （0 / 3 / 10000–19999）のみを対象とし、addressable な kind を設定すると構築時に
  例外を投げる。
- **鮮度ウィンドウは部分ヒットを絞り込まない**: `authors` の一部だけが新鮮な場合、
  そのフィルタは元のまま上流へ転送される（新鮮でない author だけに絞った残余
  フィルタは作らない）。著者を多数まとめて引く REQ では節約が効きにくい。
- **鮮度ウィンドウでスキップした購読はライブ更新を受け取らない**: 上流購読を
  開かないため、その購読が生きている間の新着は届かない（第5節のトレードオフ）。
- **`ids` 指定のショートサーキットは未実装**: id は内容ハッシュで不変なので
  「要求 id 全件がキャッシュにあれば上流に聞かなくてよい」が原理的に成り立つが、
  今回の鮮度ウィンドウとは別の判定経路になるため実装していない。
