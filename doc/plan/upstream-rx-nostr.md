# 上流接続層を rx-nostr へ寄せる計画

> **状況（2026-08 時点）**: 実装済み。移行手順（第6節）のチェックボックスは実装
> 状況に合わせて更新してある。第5節で「着手前に決める」としていた 2 点の結論は
> 各項に追記した。移行後の設計は
> [cache-relay/upstream.md](../cache-relay/upstream.md) 第2.1節が正となる。
>
> **実測**: `upstream-connection.ts`（249 行）を削除し、`upstream-relay-pool.ts` は
> 169 → 323 行。コメント・空行を除いた実コード行は上流レイヤー本体で 312 → 190 行
> （−39%）、テストで 331 → 243 行（−27%）。第2節の見込みほどは減っていない。
> 差の主因は EOSE 集約が残ること（第4.3節）と、第5.1節の再接続方針を
> 「rx-nostr 既定 + 再武装」で実装したぶんの上乗せ。

## 1. 目的

`packages/cache-relay/src/upstream/` の接続レイヤーが、rx-nostr がすでに提供している
機能を手書きで再実装している。クライアント側を rx-nostr に寄せた結果、同じ依存が
すでにツリーに入っているので、上流側も寄せて重複を消す。

重複しているのは「1 リレー 1 ソケットの寿命管理」と「複数リレーへのファンアウト」で、
**キャッシュとしての判断（リードスルー / 重複排除 / backfill / 鮮度ウィンドウ）は
このプロジェクト固有のロジックなので対象外**。それらは `UpstreamCoordinator` と
`freshness.ts` に閉じており、今回は触らない。

### 重複の実態

| `upstream-connection.ts` / `upstream-relay-pool.ts` が持っている処理 | rx-nostr |
|---|---|
| 指数バックオフ再接続（`reconnectBaseDelay` / `reconnectMaxDelay` / `reconnectAttempts`） | `retry` 設定（既定: 指数バックオフ + jitter・5 回） |
| 接続タイムアウト（`connectTimer` → 強制 close → 再接続） | 相当機能なし（第 5 節） |
| 再接続後にアクティブ購読の REQ を再送（`activeSubscriptions` Map） | `getReconnectedObservable()` + `SubscribeProxy` の recovery |
| ソケットのハンドラ配線・`dropSocket` による無害化 | 内蔵 |
| 受信メッセージの JSON パースと EVENT / EOSE の振り分け | `MessagePacket` として型付きで届く |
| 複数リレーのプール・接続数カウント | `setDefaultRelays([...])` / `getAllRelayStatus()` |
| URL の重複排除 | `UrlMap`（正規化してキーにする） |

## 2. 削減見込み

| ファイル | 現状 | 見込み | 実績 |
|---|---|---|---|
| `upstream-connection.ts` | 249 行 | **削除** | **削除** |
| `upstream-connection.spec.ts` | 210 行 | **削除** | **削除** |
| `upstream-relay-pool.ts` | 169 行 | 100 行前後（第 4.3 節の EOSE 集約が残るため） | 323 行 |
| `upstream-relay-pool.spec.ts` | 191 行 | 同程度（フェイクの作り方だけ変わる） | 331 行 |

本体で約 300 行、テストで約 200 行の削減。`upstream-coordinator.ts`（319 行）と
`freshness.ts`（271 行）は**変更しない**。

実績は見込みほど減らなかった（コメント・空行を除いた実コード行で本体 312 → 190 行、
テスト 331 → 243 行）。EOSE 集約が丸ごと残ること（第 4.3 節）に加え、第 5.1 節の
再接続方針と、rx-nostr へ渡す設定ひとつひとつが「なぜその値なのか」を説明する
コメントを要求したため。

## 3. 方針: `UpstreamPool` インターフェースは変えない

`upstream-types.ts` の `UpstreamPool` はすでに抽象化として切られていて、

- `NostrRelayOptions.upstreamPool` として公開の注入点になっている
- `packages/timeline-embed` の `InstrumentedUpstreamPool` がデコレータとして被せ、
  cache-relay 無改変で上流トラフィックを計測している
- coordinator のテストがモックを注入している

インターフェースを保ったまま実装だけを差し替えれば、**呼び出し側は 1 行も変わらない**。
`UpstreamRelayPool` を rx-nostr ベースに書き直し、`UpstreamConnection` を消す。

```
UpstreamCoordinator（変更なし）
  └─ UpstreamPool（インターフェース。変更なし）
       └─ UpstreamRelayPool ← ここだけ中身を差し替える
            └─ RxNostr（1 インスタンスで全上流リレーを保持）
```

## 4. 設計

### 4.1 `UpstreamRelayPool` の構成

`RxNostr` を 1 インスタンス持ち、全上流リレーを既定リレーとして登録する。
現状の「1 リレー 1 `UpstreamConnection`」という構造自体が無くなる。

| `UpstreamPool` のメソッド | rx-nostr での実装 |
|---|---|
| `start()` | `createRxNostr(...)` → `setDefaultRelays(urls)`。`connectionStrategy: 'aggressive'` で即座に接続を開始する（現状の `start()` と同じセマンティクス） |
| `stop()` | `rxNostr.dispose()` |
| `publish(event)` | `rxNostr.send(event, { completeOn: 'sent' })`。署名済みイベントしか来ないので passthrough signer を渡す（`RelayConnection` と同じ） |
| `openSubscription(subId, filters)` | `createRxForwardReq(subId)` を `use()` して購読し、`emit(filters)` |
| `closeSubscription(subId)` | 保持している RxJS Subscription を `unsubscribe()`（rx-nostr が CLOSE を送る） |
| `onEvent(cb)` | `use()` の `EventPacket` から `(subId, event, packet.from)` を組む |
| `onEose(cb)` | 4.3 節（自前の集約が残る） |
| `getConnectedCount()` | `getAllRelayStatus()` を数えて `connection === 'connected'` の件数 |

`upstreamSubId` は forward strategy のワイヤ上で `${subId}:0` になるため、
`RelayConnection` と同じく変換関数を 1 つ置いて相互に引く。coordinator が採番する
`up1` 形式なので 64 文字制限には余裕がある。

### 4.2 `createRxNostr` の設定

```ts
createRxNostr({
  // 上流イベントの検証は MessageHandler.ingestUpstreamEvent が
  // validateEventsType に従って行う。ここで検証すると二重処理になり、
  // `NONE` を指定しても検証されてしまう
  skipVerify: true,
  // NIP-40 は cache-relay 自体が未対応（TODO 参照）。既定のままだと
  // 上流経路だけ期限切れイベントが落ちるという非対称が生まれる
  skipExpirationCheck: true,
  // 現状と挙動を揃える。有効化は別途判断（第 5 節）
  skipFetchNip11: true,
  connectionStrategy: 'aggressive',
  signer: passthroughSigner,
  // エミュレータが差し替える前のコンストラクタ。start() 時点で解決する
  websocketCtor: options.webSocketFactory(),
});
```

**`skipVerify: true` は必須**。ここを既定のままにすると、`validateEventsType: 'NONE'`
を指定しても上流経路だけ署名検証が走り、オプションの意味が壊れる。

**重複排除を rx-nostr 側で行ってはいけない**（`uniq()` を挟まない）。coordinator は
上流が既配信 id を返したことを `onDuplicate` で検知して鮮度ウィンドウを再武装する
（upstream.md 第 5 節「窓の再武装」）ため、各リレーのコピーがすべて届く必要がある。

**`webSocketFactory` の遅延評価は `start()` で吸収する**。ブラウザではエミュレータが
`globalThis.WebSocket` を差し替えるので、上流には差し替え前のものを使う必要がある
（自己接続ループの防止）。`RxNostr` の生成を `start()` 内に置けば、その時点で
ファクトリを 1 回評価して `websocketCtor` に渡すだけでよい。
`UpstreamPoolOptions.webSocketFactory` は互換のため残す。

### 4.3 EOSE 集約は rx-nostr では吸収できない（重要）

**rx-nostr の EOSE 集約は backward strategy の機能で、今回は使えない。**

backward strategy は EOSE で購読を自動 CLOSE する。しかし上流購読は EOSE 後も
開いたままにしてライブイベントを流し続ける設計（upstream.md 第 3 節）なので、
forward strategy を使わざるを得ない。forward strategy では `use()` は EVENT しか
流さず、EOSE は `createAllMessageObservable()` から拾うことになる。

したがって以下は**残る**:

- 購読開始時点で接続済みだったリレー集合のスナップショット（`pendingEose`）
- 全員が EOSE を返したら 1 回だけ発火
- リレーが落ちたらその集合から除いて、空になれば発火

ただし材料は rx-nostr から取れるので実装は縮む:

- 「いま接続済みのリレー」→ `getAllRelayStatus()`
- 「リレーが落ちた」→ `createConnectionStateObservable()`（自前の `onDisconnect`
  コールバック配線が不要になる）
- EOSE の受信 → `createAllMessageObservable()` の `type === 'EOSE'`

`upstream-relay-pool.ts` が 169 行 → 100 行前後にしか減らないのはこのため。
**「rx-nostr に寄せれば EOSE 集約がタダになる」わけではない**点は、着手前に
認識を揃えておくこと。

## 5. 挙動が変わる点（着手前に判断が要る）

### 5.1 再接続が無制限 → 有限（要判断）

現状は `close()` されるまで無制限にリトライする（上限 60 秒のバックオフ）。
rx-nostr の既定は 5 回で打ち切り、以後は `error` 状態で止まる。

- upstream.md の「既知の制限」は無制限リトライを**欠点**として挙げている
  （到達不能な URL を誤設定すると再接続ログが出続ける）ので、有限化は改善でもある
- 一方、長時間開きっぱなしのタブやサーバープロセスでは、一時的なネットワーク断で
  上流を永久に失うことになる。これは現状より明確に悪い

**推奨**: 既定のまま（5 回）にはせず、`retry` に長めの `linear` を指定するか、
`error` 状態を検知して `rxNostr.reconnect(url)` を呼ぶ復帰口を用意する。
どちらにするかは着手時に決める。クライアント側（`RelayConnection`）とは前提が
違う（ページは再読み込みできるが、サーバープロセスはできない）ので、
同じ「既定に任せる」判断をそのまま持ち込まないこと。

**結論**: 後者（復帰口）を採った。`retry` は `exponential`・5 回・`initialDelay`
は `reconnectBaseDelay`（既定 1 秒）で rx-nostr の既定どおりにし、`error` 状態を
`createConnectionStateObservable()` で検知して `reconnectMaxDelay`（既定 60 秒）後に
`rxNostr.reconnect(url)` を呼ぶ。これで**再接続は従来どおり無制限**のまま、
一時的な断は 30 秒以内のラダーで復帰し、恒久的に落ちている URL への再接続も
60 秒に 1 回までに収まる。長い `linear` 一本にしなかったのは、最初の再試行まで
`interval` ぶん待つことになり、ありふれた瞬断の復帰が目に見えて遅くなるため。
`rejected`（リレーが 4000 で閉じた = 二度と来るなの意思表示）は再武装しない。

### 5.2 `upstreamConnectionTimeout` が実現できなくなる

rx-nostr に接続タイムアウトの設定は無い（`disconnectTimeout` / `eoseTimeout` /
`okTimeout` / `authTimeout` のみ）。`NostrRelayOptions.upstreamConnectionTimeout` は
公開オプションなので、非推奨として残して無視するか、削除するかを決める必要がある。

実害は小さい。現状これは「開かないソケットを強制的に閉じて再接続を早める」ための
もので、WebSocket 自体のタイムアウトでいずれ `close` は来る。

**結論**: 非推奨として残し、無視する。`NostrRelayOptions` も
`NostrRelayServerOptions.relay` も公開オプションなので、削除すると利用側の
コンパイルが落ちる。`UpstreamPoolOptions.connectionTimeout` も同様に
`@deprecated` を付けて残した（渡しても何も起きない）。

### 5.3 `relayUrl` が正規化される

rx-nostr は URL を正規化して保持する（末尾スラッシュ除去・hash 除去・クエリのソート）。
`onEvent` の第 3 引数と `getAllRelayStatus()` のキーは正規化後の文字列になるため、
`wss://nos.lol/` を設定すると `wss://nos.lol` として返る。

`CacheMetrics.recordUpstreamEvent(eventId, relayUrl)` がこの値を使い、デモの計測表示に
出る。壊れはしないが、設定値と表示が一致しなくなる点は把握しておく。

### 5.4 NIP-11 の取得

rx-nostr は既定で各リレーの NIP-11 ドキュメントを HTTP で取得し、`max_subscriptions`
などの制限に合わせて REQ をキューイングする。現状の実装にはこの機能が無い。

初回は `skipFetchNip11: true` で現状と揃える。有効化は上流リレーごとに HTTP
リクエストが 1 本増えるので、埋め込みウィジェットのコスト込みで別途判断する。

## 6. 移行手順

- [x] `UpstreamRelayPool` を rx-nostr ベースで書き直す（`UpstreamPool` は変更しない）
  - [x] `createRxNostr` の設定（4.2 節）。`skipVerify: true` を忘れないこと
  - [x] forward req による購読と `${subId}:0` の相互変換
  - [x] EOSE 集約を `getAllRelayStatus()` / `createConnectionStateObservable()` /
        `createAllMessageObservable()` の上で組み直す（4.3 節）
  - [x] `publish` の passthrough signer
- [x] 5.1 の再接続方針を決めて `retry` を設定する（`error` 状態からの再武装を併用）
- [x] `upstream-connection.ts` と `upstream-connection.spec.ts` を削除
- [x] `UpstreamPoolOptions` の整理。`reconnectBaseDelay` は rx-nostr の
      `retry.initialDelay` へ、`reconnectMaxDelay` は再武装の待ち時間へ読み替え、
      `connectionTimeout` は `@deprecated` で残して無視する
- [x] `NostrRelayOptions.upstreamConnectionTimeout` の扱いを決める（5.2 節）
- [x] `packages/cache-relay/package.json` に `rx-nostr` を追加
- [x] [cache-relay/upstream.md](../cache-relay/upstream.md) の第 2.1 / 2.2 節と
      「既知の制限」の再接続の項を更新

## 7. テスト方針

**rx-nostr の挙動そのものはテストしない。** リトライ回数・バックオフの刻み・
再接続時の REQ 再送はライブラリの責務で、既定値が変わるたびに落ちる負債になる。
（クライアント側で同じ判断をして、該当するテストを削除済み）

こちら側のコードとして残るのは次で、テストもここに絞る。

- **EOSE 集約**（4.3 節）: 接続済みリレー全員が返したら 1 回だけ発火する /
  0 台なら即発火する / 購読中に落ちたリレーは待たない。
  既存の `upstream-relay-pool.spec.ts` の観点をそのまま引き継げる
- **`upstreamSubId` の相互変換**: coordinator が採番した id で EVENT / EOSE が
  正しく引けること
- **`skipVerify` が効いていること**: `validateEventsType: 'NONE'` で、署名が不正な
  上流イベントもクライアントへ届く（= rx-nostr が握り潰していない）
- **重複排除をしていないこと**: 複数リレーが同じイベントを返したとき、
  `onEvent` がリレーの数だけ呼ばれる（鮮度ウィンドウ再武装の前提）

`upstream-coordinator.spec.ts` はモック `UpstreamPool` を注入しているので**無変更で
通るはず**。通らなければインターフェースを壊している。

## 8. 影響範囲

| パッケージ | 影響 |
|---|---|
| cache-relay | `upstream/` のみ。`rx-nostr` が runtime dependency に加わる |
| server | 依存が増えるだけ。Node 22 のネイティブ `WebSocket` で動くので `ws` は不要のまま |
| timeline-embed | なし（`InstrumentedUpstreamPool` は `UpstreamPool` にだけ依存） |
| demo-site / web-client | なし |

埋め込みバンドルへの追加はほぼゼロ。rx-nostr は `timeline-embed` 経由ですでに
入っているため、cache-relay が同じものを使っても増えない。

## 9. やらないこと

- `UpstreamCoordinator` / `FreshnessGate` の書き換え。キャッシュとしての判断は
  このプロジェクト固有のロジックで、ライブラリで置き換わるものではない
- 購読の多重化（同一フィルタの複数購読を 1 本にまとめる）。rx-nostr の `batch()`
  で可能だが、別の最適化なので混ぜない
- 上流 AUTH（NIP-42）対応。rx-nostr は `authenticator` を持っているので**将来は
  安く実現できる**が、この移行のスコープには入れない
