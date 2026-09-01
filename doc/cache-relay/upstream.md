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
                                            └─ UpstreamRelayPool（EOSE 集約）
                                                  └─ RxNostr（1 インスタンスで全上流リレーを保持。
                                                        接続・再接続・購読再確立）
```

`upstream/` に 2 つのクラスと型定義を置く。

### 2.1 UpstreamRelayPool（`upstream/upstream-relay-pool.ts`）

上流リレー群への `REQ` / `EVENT` / `CLOSE` のファンアウトを担う。

**接続の寿命管理は [rx-nostr](https://github.com/penpenpng/rx-nostr) が持つ**。
`RxNostr` を 1 インスタンス生成し、全上流リレーを既定リレー
（`setDefaultRelays`、`connectionStrategy: 'aggressive'`）として登録する。
ソケットの開閉・再接続・再接続後の `REQ` 再送・URL の正規化と重複排除は
すべてライブラリ側の責務で、このクラスには無い。

`createRxNostr` の設定のうち、外せないものは次の 2 つ。

- **`skipVerify: true`**: 上流イベントの検証は `MessageHandler.ingestUpstreamEvent`
  が `validateEventsType` に従って行う。ここで検証すると二重処理になり、
  `NONE` を指定しても検証されてしまう
- **`skipExpirationCheck: true`**: NIP-40 はリレー本体が未対応。既定のままだと
  上流経路だけ期限切れイベントが落ちるという非対称が生まれる

`skipFetchNip11: true`（上流リレーごとの HTTP リクエストを増やさない）と
passthrough signer（上流へ流すのは署名済みイベントだけなので、既定の NIP-07
signer を使わせない）も指定する。**重複排除は行わない**（`uniq()` を挟まない）。
各リレーのコピーがすべて届くことが、第5節「窓の再武装」の前提だからである。

このクラスに残っているのは **EOSE の集約**で、これは rx-nostr では吸収できない。
rx-nostr の EOSE 集約は backward strategy の機能で EOSE 時に購読を閉じてしまうが、
上流購読は EOSE 後も開いたままにする必要がある（第3節）ため forward strategy を
使う。forward strategy では `use()` に EVENT しか流れず、EOSE は
`createAllMessageObservable()` から拾うことになる。

- `openSubscription` 時点で**接続確立済みだったリレー集合**を記録し、それら全員が
  `EOSE` を返したときに 1 回だけ `onEose` を発火する（0 台なら次の tick で即発火）。
- 後から接続（再接続含む）したリレーは集約対象に加えない。落ちているリレーによって
  クライアントの EOSE が永遠に遅延する事故を防ぐため。
- 集約中のリレーが落ちたら（`createConnectionStateObservable()` が `connected` 以外を
  報告したら）その集合から除く。空になれば発火する。
- `maxRelays`（既定 `DEFAULT_MAX_CONCURRENT_RELAYS`）を超える URL は警告して無視する。

購読 id は、coordinator が採番した `upstreamSubId`（`up1` 形式）をそのまま
`createRxForwardReq()` の id に渡す。ワイヤ上の id は forward strategy では
`${upstreamSubId}:0` に固定されるため、共有メッセージストリームで届く EOSE から
元の `upstreamSubId` を一意に引き直せる。

**再接続は無制限に試み続ける**。rx-nostr の自動リトライ（指数バックオフ・
`reconnectBaseDelay` 起点・5 回）を使い切ったリレーは `error` 状態で止まるので、
`reconnectMaxDelay`（既定 60 秒）待ってから `rxNostr.reconnect(url)` で再武装する。
ブラウザのタブと違いリレープロセスは再読み込みできず、一度のネットワーク断で上流を
恒久的に失うわけにはいかないため。リレーが 4000 で閉じた（`rejected`）場合は
「二度と来るな」の意思表示なので再武装しない。

### 2.2 UpstreamCoordinator（`upstream/upstream-coordinator.ts`）

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
       （fire-and-forget。送信できた時点で完了とし上流の OK は待たない。
         切断中リレーへは実質ドロップ = 再接続時に再送されない）
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

### REQ（id カバレッジでスキップされる場合）

```
client ── ["REQ", subId, {"ids":[x]}] ──▶ handleReqMessage
  ├─ storage.getEvents → capEvents → client へ ["EVENT", subId, ev]×N（id を sentIds に記録）
  ├─ narrowFiltersByIdCoverage(filters, sentIds)  ← 常時。ストレージアクセスなし
  │    └─ filter.ids ⊆ sentIds のフィルタを除外（第6節）
  ├─ 残ったフィルタがあれば FreshnessGate へ（下記）
  └─ 残ったフィルタが 0 件 → 上流購読を開かず client ◀── ["EOSE", subId] を即送出
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

## 4. オプション

この層を制御するのは `NostrRelayOptions` の `upstreamRelays` / `upstreamEoseTimeout` /
`upstreamFreshness` / `upstreamPool` の 4 つ。**意味と既定値は
[doc/api.md](../api.md#interface-nostrrelayoptions) を参照**（このドキュメントは
判定アルゴリズムとトレードオフだけを扱う）。

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

`ids` 指定のフィルタはこの窓の対象外で、より強い短絡が別に効く（第6節）。
判定順は id カバレッジが先で、そこで残ったフィルタだけがこの窓に渡る。

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

「新鮮だ」と証明できない状況はすべて「従来どおり上流へ転送」に倒す。証明できない
鮮度でキャッシュを返すことだけが、透過性を静かに壊す失敗モードだからである。
具体的には次がすべて古い扱いになる。

- `getCachedAt` 未実装のアダプタ（警告1回を出して機能全体を無効化）
- `getCachedAt` のエラー（部分的な結果は返さず空で扱う）
- `cached_at` が数値でない / `NaN` / `Infinity` / 未保存
- `cached_at` が未来（`Date.now()` は単調ではなく、SQLite 構成では再起動をまたいで
  比較するため、クロックスキューで窓が無限に伸びないようにする）
- 窓の秒数が有限の正数でない（`FreshnessGate` は公開エクスポートで、
  `normalizeFreshnessWindows` を通らない設定が渡されうる）

素朴に `now - cached > 窓 * 1000` と書くとこれらが逆側（新鮮）に倒れる。`NaN` を
含む比較は常に `false` になるためである。判定は `isWithinWindow` に集約し、
すべての入力が健全なときだけ true を返す形にしてある。

### 窓の再武装

窓が切れた REQ は上流へ転送されるが、**内容が変わっていない replaceable では
上流も同じ event id を返す**。この id は既配信として重複排除され、`ingest` に
届かないので `saveEvent` が呼ばれず、`cached_at` も書き換わらない。

これを放置すると窓は二度と再武装せず、最初の1窓が切れた後は毎回上流へ問い合わせる
ことになる。「プロフィールはほとんど変わらない」という、この機能が本来効くはずの
ケースで効かなくなってしまう。

そのため、上流が既配信の id を返してきたときは `UpstreamCoordinatorDeps.onDuplicate`
経由で `FreshnessGate.markRevalidated` を呼び、`storage.touchCachedAt` で `cached_at`
を打ち直す（= 上流が「その版が最新だ」と確認した時刻）。再検証は読み出し経路の
付随処理なので fire-and-forget で、失敗しても REQ には影響しない。窓が設定された
kind のイベントだけが対象なので、通常 kind の大量トラフィックがここでストレージに
触ることはない。

再保存と同じく、この打ち直しは対象イベントの **TTL も数え直しになる**。

### トレードオフ

- **スキップされた購読はライブ更新を受け取らない**。上流購読を持たないため、
  その購読が生きている間の新着は届かない。HTTP キャッシュと同じ
  「次回のリクエストで再検証する」セマンティクスになる
- 窓の内側では上流の更新が見えない。`ttl` と違いキャッシュは削除されず、窓が
  切れた次の REQ で上流に問い合わせて再検証される（新しい版が来れば置換され、
  同じ版なら上記のとおり窓が再武装する）
- `ttl` と併用する場合は **`ttl` > 窓** にすること。`getEvents` は TTL 期限切れを
  読み出し時に絞り込まない（削除はバックグラウンドスイープ任せ）ため、`ttl` が
  窓より短いと「期限切れだがスイープ未実行」のイベントを新鮮と判定しうる。
  逆に `ttl` が極端に短いと窓が実質無効になる。どちらも警告は出ない
- 判定コストは REQ ごとに `getCachedAt` 1回（主キー検索、アクセス追跡なし）。
  適用対象フィルタが無い場合、および上流が未設定の場合はストレージに触らない

## 6. id カバレッジ短絡（exact read-through）

第5節の鮮度ウィンドウは「上流にもっと新しい版があるかもしれない」を**時間で妥協**して
いる。`ids` 指定のフィルタにはその妥協が要らない。id はイベント内容のハッシュであり、
同じ id を持つ「より新しい版」は存在しえないからである。

この違いは判定の強さに直結する。`filter.ids` に挙がった id をすべてキャッシュが持って
いるなら、そのフィルタにマッチしうるイベントは高々その n 件で、すべて配信済みである。
つまり**上流購読を開いても今後届くものが無い**。EOSE を早めるだけでなく、上流購読
そのものが不要になる。

実装は `upstream/id-coverage.ts`（純粋関数のみ）。**設定オプションは無い**。鮮度
ウィンドウが「どのくらい古いキャッシュまで許容するか」という主観的な方針であるのに
対し、こちらは内容アドレスであることから導かれる正確な判定なので、`upstreamRelays` が
設定されていれば `upstreamFreshness` の有無に関わらず常に適用される。transport 経由の
REQ（`MessageHandler.handleReqMessage`）とインプロセスの
`NostrCacheRelay.subscribe()` の両方が同じ2段の判定を通る。

### 判定アルゴリズム

REQ のフィルタごとに独立に判定する。

> covered(filter) ⟺ `filter.ids` が定義済み かつ その全要素が
> **その REQ でローカルから配信した id 集合**に含まれる

- 追加のストレージアクセスは伴わない。判定材料の id 集合は、上流由来イベントの重複
  排除のために `handleReqMessage` がどのみち集めているものをそのまま使う
- 根拠にするのは「そのフィルタにマッチしたか」ではなく「キャッシュが保持しているか」
  なので、**同一 REQ 内の別フィルタが配信した id も証拠に使える**
- `kinds` や `since` など他の条件を併せ持つ id フィルタも、id さえ揃っていれば充足と
  判定してよい。それらの条件は結果を絞るだけで、上流に聞いても答えは変わらないため
- `ids: []` は充足扱い。ローカルでは何にもマッチしない（`eventMatchesFilter`）ので
  整合し、空配列を「制約なし」と解釈する上流にファイアホースを開かせる事故も防げる。
  `ids` 以外の条件は見ないので、`{"ids":[],"kinds":[1]}` のような複合フィルタも同様に
  落ちる（従来は上流へ転送されていたため、利用者から見える挙動変化）
- `ids` が配列でない不正なフィルタは非充足に倒す。`isValidFilterShape` は選言なので
  `{"ids":"abc","limit":1}` は `limit` を根拠に受理されうる

適用順は **id カバレッジ → 鮮度ウィンドウ**。前者で残ったフィルタだけが後者に渡る。
全フィルタが落ちれば上流購読を開かず、その場で EOSE を返す（第5節と同じ経路）。

### フェイルオープン

「保持しているが他の条件で外れた」「`limit` / `maxEventsPerRequest` で切り捨てられた」
場合、その id は配信されていないので**非充足**と判定され、従来どおり上流へ転送される。
充足を証明するには「どの id が存在するか」をストレージに問い合わせる必要があり、
判定を無コストに保つことを優先して保守側に倒している。

### 前提と限界

- **`id` が内容のハッシュであることは検証していない**（第7節）
- 効くのは `ids` 指定のフィルタだけである。`{"kinds":[7],"#e":[…]}` のような
  「開いた」フィルタは、新しいイベントが今後も増えるため上流必須で、EOSE の保留も
  そのまま残る

メッセージフローは第3節「REQ（id カバレッジでスキップされる場合）」を参照。

## 7. 設計上の判断とトレードオフ

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
  評価は構築時ではなく `RxNostr` の生成時（`start()`、またはそれより前に REQ が
  届いたならそのとき）で、結果を `websocketCtor` に渡す。
- **接続レイヤーは自前で持たない**。指数バックオフ再接続・再接続後の REQ 再送・
  複数リレーのファンアウトはいずれも rx-nostr が持っており、クライアント側
  （`timeline-embed` の `RelayConnection`）で同じ依存をすでに使っている。
  一方で**キャッシュとしての判断（リードスルー / 重複排除 / backfill / 鮮度
  ウィンドウ）はライブラリで置き換わるものではない**ので、`UpstreamCoordinator` と
  `freshness.ts` はそのまま自前で持つ。

## 8. 既知の制限（将来課題）

追跡中の課題（`id` の検算、部分カバー時の残余フィルタ、EOSE 保留ポリシー、鮮度ウィンドウの
再武装）は [doc/TODO.md](../TODO.md) を参照。ここには、この層の設計から直接くる性質だけを
挙げる。

- **再送キューは持たない**: 上流が全滅している間に投稿された EVENT は転送されず失われる
  （クライアントへの `OK` は `true` で返る）。オフライン中の投稿を後で送る仕組みは未実装。
- **購読多重化はしない**: クライアント購読 1 に対し上流購読 1（1:1）。同一フィルタの
  複数購読をまとめて 1 本の上流購読にする最適化は行わない。
- **重複排除はメモリ内・上限つき**: 上限を超えると古い id を破棄するため、極端に長寿命で
  大量のイベントが流れる購読では、ごく稀に既送イベントの再配信が起こりうる。
- **再接続時の再送で TTL が延びる**: 再接続で同じイベントが再送されると、`DexieStorage`
  の `put` 冪等性で重複保存は防げるが、`cached_at` がリセットされ TTL が延びる。
- **再接続は無制限リトライ**: 切断された上流へは、rx-nostr の自動リトライ（指数
  バックオフ・5 回）と `reconnectMaxDelay`（既定 60 秒）ごとの再武装で、`stop()`
  されるまで再接続を試み続ける（第2.1節）。到達不能な URL を誤設定すると再接続が
  60 秒おきに走り続ける。サーキットブレーカは未実装。
- **接続タイムアウトが無い**: rx-nostr に接続タイムアウトの設定が無いため、
  かつての `upstreamConnectionTimeout` オプションは削除した。開かないソケットは
  WebSocket 自身のタイムアウトで `close` になり、そこから再接続ラダーが動く。
- **`relayUrl` は正規化後の文字列**: rx-nostr が URL を正規化して保持する
  （末尾スラッシュ・hash の除去、クエリのソート）ため、`onEvent` の第3引数は
  設定値そのままとは限らない（`wss://nos.lol/` → `wss://nos.lol`）。
  `CacheMetrics.recordUpstreamEvent` 経由でデモの計測表示に出る値もこれになる。
- **上流 AUTH（NIP-42）などは未対応**: 認証が必要な上流リレーには接続できない。
- **鮮度ウィンドウは addressable 未対応**: 30000–39999 は座標に `d` タグが入るため、
  フィルタに `#d` がなければ期待集合を列挙できない。replaceable（0 / 3 / 10000–19999）
  のみを対象とし、addressable な kind を設定すると構築時に例外を投げる。
- **鮮度ウィンドウは部分ヒットを絞り込まない**: `authors` の一部だけが新鮮な場合、
  そのフィルタは元のまま上流へ転送される（新鮮でない author だけに絞った残余
  フィルタは作らない）。著者を多数まとめて引く REQ では節約が効きにくい。
- **鮮度ウィンドウでスキップした購読はライブ更新を受け取らない**: 上流購読を
  開かないため、その購読が生きている間の新着は届かない（第5節のトレードオフ）。
