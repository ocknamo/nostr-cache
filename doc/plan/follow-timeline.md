# フォロータイムライン埋め込みの設計検討

> **状況**: 未着手。この文書は実装方針の検討結果であり、確定した仕様ではない。
> 「要検討」と書いた箇所は実装時に実測・判断が要る。

## 1. 何を作るのか

指定した pubkey が **NIP-02（kind 3・フォローリスト）でフォローしている人たちの投稿**を
並べる埋め込みウィジェット。既存の `<nostr-timeline>` が「フィルタを直接書く」ものなのに対し、
こちらは「人を 1 人指定すると、その人のホームタイムラインが出る」もの。

```html
<nostr-follow-timeline
  pubkey="npub1..."
  relays="wss://nos.lol,wss://relay.damus.io"
></nostr-follow-timeline>
```

## 2. 既存実装との本質的な差分

既存ウィジェットは **「起動時に決まった静的フィルタ 1 本 → REQ 1 本」** である。
`parseFilters()` が属性を `Filter[]` にして `TimelineController.start(filters)` に渡し、
以後フィルタは変わらない（`packages/timeline-embed/src/nostr-timeline.svelte:135`）。

フォロータイムラインは **2 段階**になる。

```
1. REQ {"kinds":[3],"authors":[<subject>],"limit":1}   → kind 3 を得る
2. p タグ → authors を組み立てる
3. REQ {"kinds":[1],"authors":[<follows…>],"limit":50} → タイムライン
```

**フィルタが実行時にリレーから決まる**のはこれが初めてで、設計上の争点はほぼここに集約される。
残りは「フォロー数が多い」ことに由来する量の問題。

## 3. 形態の選択：新しいカスタム要素にする

| 案 | 内容 | 評価 |
|---|---|---|
| A | 既存 `<nostr-timeline>` に `follows-of` 属性を追加 | 属性の優先順位が三すくみになる |
| B | **新しいカスタム要素 `<nostr-follow-timeline>`（内部は共有）** | **推奨** |
| C | ライブラリ層だけ提供し、要素は作らない | 埋め込みウィジェットとして使えない |

**A を採らない理由**が主。既存要素には `filters` と `authors` があり、そこに `follows-of` が
加わると「`filters` > `follows-of` > `authors`」のような 3 段の優先順位規則が要る。
組み合わせごとの意味を README に書くコストが実装より大きく、`filters` を書いた人が
`follows-of` を黙って無視される事故も起きる。

**B の利点**は、`pubkey` が必須であることを要素の存在自体で表現でき、`authors` / `filters`
属性がそもそも無いので優先順位の問題が消えること。

**B の重複コスト**は props 宣言だけに閉じられる。Svelte のカスタム要素は
`<svelte:options customElement>` で props を静的に宣言する必要があるため、
`relays` / `db-name` / `debug` / `show-avatars` / `show-media` などの宣言は 2 箇所に書く。
中身は現 `nostr-timeline.svelte` の body（state 保持 + `Timeline` 描画 + エラー/再接続表示 +
スタイル）を `TimelineView.svelte` として抽出し、両要素から使う。

バンドルは 1 本のまま（`embed-entry.ts` が両方を import する）。増分は数 KB。

### iframe ページ

`public/embed/index.html` は **1 枚のまま**にし、`pubkey` パラメータの有無で生成する要素を
切り替える。高さの `postMessage` ロジックを二重に持ちたくないため。

```
embed/?pubkey=npub1...&relays=wss://nos.lol&limit=50   → <nostr-follow-timeline>
embed/?kinds=1&relays=wss://nos.lol                     → <nostr-timeline>（従来）
```

## 4. フォローリスト解決の置き場所

`TimelineController.start()` は「ホスト取得 → connect → subscribe」の 3 段。
その **connect と subscribe の間**が、実行時にフィルタを決める自然な継ぎ目である。

```ts
export type FilterSource = (ctx: { connection: RelayConnection }) => Promise<Filter[]>;

// TimelineController
async start(source: Filter[] | FilterSource): Promise<void>
```

NIP-02 の知識は新モジュール `lib/follow-list.ts` に閉じる。

- `parseFollowList(event: NostrEvent): string[]` — `p` タグから hex pubkey を抽出する純粋関数
- `followFilterSource(options): FilterSource` — kind 3 を引いて kind 1 フィルタを組む

こうすると `TimelineController` は「フィルタを取ってくる関数を呼ぶ」ことしか知らず、NIP-02 の
解釈は DOM もリレーも要らない純粋関数としてテストできる。

**代案（controller に `mode: 'follows'` を持たせる）は採らない。** controller が NIP-02 を
知ることになり、フォローリスト解釈のテストが毎回リレー起動込みになる。

## 5. kind 3 の取得は、プロフィール取得と同じ罠を踏む

`timeline-controller.ts` の `openProfileRequest` は、kind 0 を 1 件引くために 3 つの対策を
持っている（`packages/timeline-embed/src/lib/timeline-controller.ts:360`）。**kind 3 の取得は
これと完全に同型**で、同じ 3 つが必要になる。

1. **EOSE ≠ 配信完了。** リードスルー時、リレーは上流の end-of-stored を受けた時点で EOSE を
   返し、ingest 中のイベントは待たない。EOSE 即クローズだと、取ってきたばかりのフォローリストを
   取りこぼす → **EOSE 後 500ms のグレース**（`PROFILE_EOSE_GRACE_MS` 相当）
2. **最初の 1 件で確定してはいけない。** 上流が複数あると各リレーの版が別々に届き、先着が最新とは
   限らない → **`created_at` が最大のものを採る**（`ingestProfile` の `profileSeenAt` と同じ）
3. **REQ が拒否されると EOSE も CLOSED も来ない。** 購読数上限やストレージ読み取り失敗のとき
   リレーは NOTICE を出して戻るだけ → **ウォッチドッグ**（5 秒）が無いと永久に待つ

したがって、この 3 つを持つ **「replaceable を 1 件だけ引く one-shot REQ」ヘルパ**を切り出し、
プロフィール取得と共用するのが筋である。

```ts
// lib/one-shot-request.ts（仮）
export function fetchLatestReplaceable(
  connection: RelayConnection,
  filter: Filter,
  options?: { graceMs?: number; timeoutMs?: number }
): Promise<NostrEvent | undefined>;
```

切り出さずに書き下ろすと、上の 3 つのうちどれかを落として同じバグを 2 箇所で踏む。
先にプロフィール側をこのヘルパに載せ替えて既存テストが緑のままであることを確認してから、
フォローリスト側で使う。

## 6. フォローリストが無い / 空のとき

**`authors` の無い kind 1 フィルタへフォールバックしては絶対にいけない。**
上流リレー群にグローバルフィード全体を要求することになり、埋め込み先のページが
意図せず帯域を焼く。

- kind 3 が取れなかった（未公開・上流に無い・タイムアウト）
- kind 3 はあるが `p` タグが 0 件

いずれも **購読を張らずに終了**し、「フォローリストが見つかりませんでした」を表示する。
`{"kinds":[1],"authors":[]}` も送らない（空配列の解釈は NIP-01 上あいまいで、上流リレーごとに
「何にもマッチしない」と「条件なし」で割れうる）。

## 7. フォロー数の上限

実際のフォローリストは 100〜1000 件、多い人は 3000 件を超える。3 方向で効いてくる。

- **ワイヤ**: 1000 authors は 64 文字 × 1000 ≒ 66 KB の REQ。上流リレーの実装によっては
  フィルタ長で拒否される
- **ローカルクエリ**: `buildOptimizedQuery` の `authors + kinds` 分岐は
  `[pubkey+kind]` 複合インデックスに `anyOf(authors × kinds)` を渡す
  （`packages/cache-relay/src/storage/dexie/query-builder.ts:91`）。1000 authors → 1000 キー。
  さらに最終判定の `eventMatchesFilter` が `filter.authors.includes(event.pubkey)` の線形探索を
  候補行ごとに行う（`packages/cache-relay/src/utils/filter-utils.ts:76`）
- **`limit` の意味論**: `limit` はフィルタ単位。1000 人に対する limit 50 は「全体で最新 50 件」で、
  アクティブな数人で埋まる。ただしこれは実クライアントのホームタイムラインと同じ挙動なので
  問題ではない

→ **`max-follows` 属性（既定 500）で切る。** 超過分は警告ログを出して捨てる。

切る側は **先頭から N 件**を採る。NIP-02 は「新しいフォローは末尾に追記すべき」と言っているが、
実クライアントが守っている保証はなく、順序に意味を仮定しない方が安全。**既定値 500 と
「先頭を採る」は要検討** — 実測してから決める。

**分割（authors を 100 人ずつ複数フィルタに割る）は既定では採らない。**
cache-relay はフィルタごとに storage クエリと上流 REQ を行うため負荷がフィルタ数倍になり、
`MAX_FILTERS = 10` にも当たり、limit の意味論も崩れる（10 × 50 = 500 件）。

**cache-relay 側の改善余地**（このウィジェットとは別タスク）: `eventMatchesFilter` が
`authors` / `kinds` / `ids` を毎回 `includes` で線形探索している。呼び出し側で Set を作れば
authors が多いフィルタで効く。`doc/TODO.md` 行き。

## 8. 鮮度ウィンドウを kind 3 にも張る（これが一番効く）

`upstreamFreshness` は replaceable kind（0 / 3 / 10000–19999）を受け付ける
（`normalizeFreshnessWindows`、`packages/cache-relay/src/core/relay-options.ts:261`）。
そして `{"kinds":[3],"authors":[<subject>]}` は `isFreshnessEligible` の条件を**すべて満たす** —
`ids` / `since` / `until` / タグ条件が無く、`kinds` は非空で全部 replaceable かつ窓あり、
`authors` も非空（`packages/cache-relay/src/upstream/freshness.ts:110`）。

つまり `relay-host.ts` の `upstreamFreshness` に `3: followsFreshness` を足すだけで、
**2 回目以降のロードでは上流に一切問い合わせずフォローリストがキャッシュから即座に出る**。
このプロジェクトの売り（透過キャッシュ）がそのまま効く題材で、デモとしても分かりやすい。

- 属性 `follows-freshness`（秒。`0` で毎回上流へ）
- **既定 3600（1 時間）** — プロフィール（24 時間）より短くする。フォローの増減は表示名や
  アバターより動くため。ただし**要検討**
- `RelayHostConfig` はページ共有・最初の 1 つ勝ちなので、値が食い違うと `warnOnConflict` が出る。
  既存の `profileFreshness` と同じ扱いで一貫している

**副次的な注意**: `storageMaxSize` を設定した構成では kind 3 が退避されると毎回上流へ戻る。
`cachePriority: { kinds: [3] }` で守れるが、現状 embed は `storageMaxSize` を設定していないので
今回は不要。README の制約に一行残す程度でよい。

## 9. 本人の投稿を含めるか

実クライアントのホームタイムラインには自分の投稿も並ぶ。`include-self`（既定 `true`）を用意し、
`true` なら authors に subject 自身を足す（重複排除する）。`max-follows` の数え方は
「フォロー先の上限」とし、self はそれと別枠にするのが直感的。

## 10. 採らない範囲（明示しておく）

- **リレーヒントは使わない。** kind 3 の `p` タグ 2 番目の要素にも、NIP-65（kind 10002）にも
  リレー URL が入るが、使うには上流リレー集合を実行時に変える必要がある。`relay-host` は
  ページ共有・起動時固定なので構造的にできない。README の制約に明記する
- **kind 3 の更新は画面を開いたまま反映しない。** kind 3 の REQ は取得後に閉じる。
  開いたままにして authors を張り替えると、タイムラインの REQ を作り直すことになり画面が飛ぶ。
  プロフィールと同じ割り切り（README「同じ著者を二度は取得しません」と同種の制約）
- **NIP-51（kind 30000 のフォローセット）は対象外。** addressable なので鮮度ウィンドウの
  対象にもならない。将来やるなら別途

## 11. 署名検証の扱い（新しい種類のリスク）

リレーは `validateEventsType: 'LAZY'` で動くので、**未検証の kind 3 を信じて authors を組む**
ことになる。既存の「✓ が付くまでは検証待ち」と同じ話ではあるが、影響が一段違う。

- 既存: 未検証イベントが **1 枚のカードとして** 混じる
- フォロータイムライン: 未検証 kind 3 が **表示される母集団そのもの** を決める

なりすまし kind 3 を上流が返すと、まったく別の人選のタイムラインが出る。
版比較（#50）が入っているので古い版での上書きはされないが、**新しい created_at を持つ
偽の kind 3** は通る（署名検証が終わるまでは）。

- **今回**: README の制約として明記する
- **将来**: `fetchValidationStatuses` で kind 3 の検証状態を引き、`pending` の間は
  「フォローリストを検証中」を出す、あるいは `IMMEDIATELY` 検証を kind 3 だけに
  かける経路を用意する。要検討

## 12. プロフィール取得との相互作用

フォロータイムラインは著者が最大 `max-follows` 人に散る。カードが見えるたびに 1 人 1 REQ を
出す既存の仕組み（並列 4 本）は、スクロールで次々に新しい著者が現れるためキューが伸びる。

既定 `limit=50` なら画面に出る著者は最大 50 人なので実際には問題にならない。
`limit` を大きくした埋め込みでは「名前が遅れて出る」体感になる。**挙動は変えず README に記載**。

## 13. 状態表示

`TimelineState` に解決フェーズを足す。

```ts
follows?: {
  status: 'resolving' | 'ready' | 'missing';
  /** authors に採用した人数（self を含む） */
  count: number;
  /** max-follows で切り捨てた人数 */
  truncated: number;
};
```

表示は `Timeline.svelte` ではなく **ウィジェット側**（`nostr-follow-timeline.svelte`）で出す。
既存の `error` / `reconnecting` の出し方と揃うし、`Timeline` はイベント描画に専念できる。

- `resolving`: 「フォローリストを取得しています…」
- `missing`: 「フォローリストが見つかりませんでした」
- `ready` かつ `truncated > 0`: `debug` のときだけ「N 人中 500 人を表示」

## 14. 属性一覧（案）

| 属性 | 内容 | 既定 |
|---|---|---|
| `pubkey` | 誰のフォローを辿るか。`npub` / `nprofile` / hex | **必須** |
| `relays` | 上流リレー URL（カンマ区切り） | なし |
| `kinds` | 並べるイベント種別 | `1` |
| `limit` | 取得件数 | `50` |
| `max-follows` | authors に載せるフォロー先の上限 | `500`（要検討） |
| `include-self` | 本人の投稿も含める | `true` |
| `follows-freshness` | kind 3 のキャッシュを上流に問い合わせ直さずに使う秒数 | `3600`（要検討） |
| `db-name` / `profile-freshness` / `debug` / `show-avatars` / `show-media` | 既存 `<nostr-timeline>` と同じ | 同じ |

`authors` と `filters` は**持たない**。`pubkey` と意味が衝突するため。

`pubkey` の解釈は `filter-json.ts` の `toPubkeyHex` と同じ規則にする（hex / `npub` / `nprofile`）。
不正なら購読を張らず「pubkey が不正です」を表示する — 既定値で動かしようがない唯一の属性なので、
他の属性の「警告して既定値で続行」とは扱いを変える。

## 15. テスト方針

- `follow-list.spec.ts`（純粋関数）: `p` タグ抽出、hex 検証、重複除去、`["p"]` だけの壊れたタグ、
  大文字 hex、`max-follows` 切り捨て、`include-self`、0 件
- one-shot REQ ヘルパ: EOSE グレース、複数版で `created_at` 最大を採る、ウォッチドッグ発火
- `FilterSource`: kind 3 が無いとき購読を張らないこと（**回帰として一番重要**）
- ウィジェット spec: 既存 `nostr-timeline.spec.ts` と同じ形
- **e2e**（`e2e/tests/browser/`）: `mock-upstream-relay` に kind 3 を足し、
  1. 2 段階の REQ が通ってタイムラインが出ること
  2. **2 回目のロードで上流に kind 3 の REQ が飛ばないこと**（鮮度ウィンドウ。これが本命）

## 16. 実装の段階分け

各段で build / typecheck / test を緑に保てる順に並べてある。

1. `lib/follow-list.ts`（純粋関数）+ テスト
2. `lib/one-shot-request.ts` を抽出し、**既存のプロフィール取得を先に載せ替える**（既存テスト緑を維持）
3. `TimelineController.start()` に `FilterSource` を受けさせる
4. `TimelineView.svelte` を抽出し、`<nostr-follow-timeline>` を追加
5. `relay-host.ts` に `followsFreshness`（`upstreamFreshness` の kind 3）
6. iframe ページの分岐・README・demo-site への追加
7. e2e

## 17. 未解決（実装時に決める）

- `max-follows` の既定値と、切り捨てを先頭から採るか末尾から採るか
- `follows-freshness` の既定値（1 時間 / 24 時間）
- 要素名: `<nostr-follow-timeline>` / `<nostr-home-timeline>`
- `truncated > 0` の表示を `debug` 限定にするか常時出すか
