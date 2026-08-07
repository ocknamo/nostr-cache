# フォロータイムライン埋め込みの設計検討

> **状況**: 未着手。この文書は実装方針の検討結果であり、確定した仕様ではない。
> 「要検討」と書いた箇所は実装時に実測・判断が要る。未解決事項の一覧は §17。
>
> 関連: [doc/TODO.md](../TODO.md)（この項目の入口）、
> [doc/cache-relay/upstream.md](../cache-relay/upstream.md)（鮮度ウィンドウ。kind 3 の例あり）、
> [doc/nips/nip-02.md](../nips/nip-02.md)

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
1. REQ {"kinds":[3],"authors":[<subject>]}             → kind 3 を得る
2. p タグ → authors を組み立てる
3. REQ {"kinds":[1],"authors":[<follows…>],"limit":50} → タイムライン
```

1 段目に `limit` は付けない。kind 3 は replaceable で (pubkey, kind) ごとに 1 件しか無いため
不要であり、`limit` 付きでも鮮度判定（§8）は通るが、付けない形で一貫させる。

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

**ただしこの案は、上で案 A を却下した理由をそのまま持ち込む。** 現在のページは
パラメータ名の配列を**無条件に**転送している（`public/embed/index.html:45-63`）ので、
`?pubkey=…&authors=…` や `?pubkey=…&filters=…` を書かれると、フォロー要素には
`authors` / `filters` が存在しないぶん**黙って無視される**。属性版では要素を分けたことで
消えていた問題が、クエリ文字列には要素の型が無いぶん復活する。

→ ページ側で `pubkey` と `authors` / `filters` の同時指定を検出し、警告を出したうえで
`pubkey` を優先する（転送する属性名の配列も要素ごとに分ける）。この分岐を書く気がないなら、
iframe だけ 2 ページに分けるほうが正直である。**要検討。**

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

### 解決中に停止されたときの後始末

`FilterSource` は最長でウォッチドッグ分（5 秒）ブロックする。その間に `stop()` が呼ばれうる
（属性変更で `$effect` の cleanup が走る、要素が DOM から外れる）。既存の `start()` は
各 await の直後に `if (this.stopped) return` を置く規律で書かれている
（`timeline-controller.ts:164, 177`）ので、`FilterSource` の await 直後にも同じ確認が要る。

さらに **kind 3 の one-shot REQ は既存の解放経路から漏れる**。`subscribe()` /
`suspend()` / `stop()` はいずれも `closeProfiles()` を呼ぶが、これが閉じるのは
`profileSubs` に登録された購読だけ（同 457-465）。kind 3 の購読は別管理になるため、
明示的に閉じる経路を用意しないと、停止後もリレー側に購読が残る。

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
  options?: {
    graceMs?: number;
    timeoutMs?: number;
    /** 中断（stop / suspend / 属性変更）。§4 の後始末で必要 */
    signal?: AbortSignal;
    /** 採用しなかった版も含め、届いた 1 件ごとに呼ぶ。下記の理由で必須 */
    onEvent?: (event: NostrEvent) => void;
  }
): Promise<NostrEvent | undefined>;
```

切り出さずに書き下ろすと、上の 3 つのうちどれかを落として同じバグを 2 箇所で踏む。

**ただし「プロフィール取得をこのヘルパに載せ替える」のは自明ではない。** 既存のプロフィール
取得は単発の Promise ではなく、次の 4 つに絡み合っている。

1. 4 並列の in-flight 予算（`MAX_CONCURRENT_PROFILE_REQUESTS`、`timeline-controller.ts:29, 336-349`）
2. `suspend()` / `stop()` による一括キャンセル（同 457-465）
3. **受信 1 件ごと**の副作用 `metrics.classifyDelivered(event.id)`（同 432）。
   `created_at` 比較で採用しなかった版も計上する必要がある（計上しないと cache/upstream の
   カウンタが配信された母集団より小さくなる）
4. 再接続時の `pumpProfileQueue()` 再駆動（同 119）

`signal` と `onEvent` があれば 2 と 3 は表現できるが、1 と 4 のキュー管理は依然 controller 側に
残る。**§16 の手順 2 は「ヘルパを新規に足し、プロフィール側の載せ替えは別タスク」に留めるのが
安全**。載せ替えを同時にやるなら、それ自体を独立した変更として先に緑にすること。

## 6. フォローリストが無い / 空のとき

**`authors` の無い kind 1 フィルタへフォールバックしては絶対にいけない。**
上流リレー群にグローバルフィード全体を要求することになり、埋め込み先のページが
意図せず帯域を焼く。

- kind 3 が取れなかった（未公開・上流に無い・タイムアウト）
- kind 3 はあるが `p` タグが 0 件

いずれも **購読を張らずに終了**し、「フォローリストが見つかりませんでした」を表示する。

`{"kinds":[1],"authors":[]}` も送らない。NIP-01 上あいまいというだけでなく、
**本リポジトリの中ですら解釈が 2 層に割れている**。

- `buildOptimizedQuery` は `authors?.length` で分岐するので、空配列を「条件なし」とみなして
  kinds ブランチへ落とす（`query-builder.ts:91, 104`）
- `eventMatchesFilter` は `filter.authors && !includes` なので「何にもマッチしない」と判定する
  （`filter-utils.ts:76`）
- `isFreshnessEligible` は `authors` 非空を要求するので、空 authors の REQ は
  **必ず上流へ転送される**（`freshness.ts:113`）

つまり空 authors は、ローカルでは 2 段の絞り込みが食い違ったまま、上流へは必ず抜けていく。
送ってよい形ではない。

## 7. フォロー数の上限

実際のフォローリストは 100〜1000 件、多い人は 3000 件を超える。3 方向で効いてくる。

- **ワイヤ**: 1000 authors は 64 文字 × 1000 ≒ 66 KB の REQ。上流リレーの実装によっては
  フィルタ長で拒否される
- **ローカルクエリ**: ここが主項。`DexieStorage.getEvents` は **`limit` 適用前に一致行を
  全件 materialize する**（`packages/cache-relay/src/storage/dexie-storage.ts:289-299` の
  実装コメントが明言している。NIP-01 の `limit` は「最新 N 件」だが Dexie の
  `Collection.limit()` は選ばれたインデックス順の先頭 N 件になるため、全件取ってから
  `capEvents` で切るしかない）。
  `{"kinds":[1],"authors":[…500],"limit":50}` は `since`/`until` を持たないので
  `buildOptimizedQuery` の `authors + kinds` 分岐に入り
  （`packages/cache-relay/src/storage/dexie/query-builder.ts:91`）、
  **500 人分の kind 1 キャッシュ行が全部 IndexedDB から取り出され、`rowToEvent` され、
  `eventRowMatchesFilter` を通ってから 50 件に切られる**。
  `eventMatchesFilter` の `filter.authors.includes(event.pubkey)` 線形探索
  （`packages/cache-relay/src/utils/filter-utils.ts:76`）はこの上に乗る二次的なコスト
- **`limit` の意味論**: `limit` はフィルタ単位。1000 人に対する limit 50 は「全体で最新 50 件」で、
  アクティブな数人で埋まる。ただしこれは実クライアントのホームタイムラインと同じ挙動なので
  問題ではない

→ **`max-follows` 属性（既定 500）で切る。** 超過分は警告ログを出して捨てる。

ただし上のとおり、支配的なコストはワイヤの 66 KB ではなく
**「キャッシュに溜まった kind 1 の量 × フォロー数」**である。`max-follows` の既定値は
そちらで見積もる必要があり、REQ サイズだけを根拠に決めてはいけない。

**あわせて検討すべき対策: タイムラインフィルタに `since`（例: 直近 N 日）を入れる。**
`since`/`until` があると `query-builder.ts:75-82` の別分岐に落ちて `created_at` インデックスで
走査範囲そのものが絞られるため、全件 materialize の母数が直接小さくなる。`max-follows` で
人数を削るより素直に効く可能性がある。ただし `since` 付きフィルタは
`isFreshnessEligible` を通らなくなる（§8）ので、**kind 1 側にだけ入れて kind 3 側には
入れない**こと。

なお `doc/TODO.md` の「`DexieStorage` の `limit` クエリで早期打ち切りできる分岐を最適化する」は
**時間範囲分岐にしか適用できない**と書かれている。`since` を入れるかどうかは、その最適化の
恩恵を受けられる側に立つかどうかの選択でもある。

切る側は **先頭から N 件**を採る。NIP-02 は「新しいフォローは末尾に追記すべき」と言っているが、
実クライアントが守っている保証はなく、順序に意味を仮定しない方が安全。**既定値 500 と
「先頭を採る」は要検討** — 実測してから決める。

**分割（authors を 100 人ずつ複数フィルタに割る）は既定では採らない。**
cache-relay はフィルタごとに storage クエリと上流 REQ を行うため負荷がフィルタ数倍になり、
limit の意味論も崩れる（10 × 50 = 500 件）。
なお `MAX_FILTERS = 10` はここでは効かない — あれは `filters` 属性の JSON を読む
`parseFilterList` 専用の上限（`packages/timeline-embed/src/lib/filter-json.ts:28,236`）で、
§4 の `FilterSource` はそこを通らない。cache-relay 側に REQ あたりのフィルタ本数上限は無い
（`message-handler.ts:296-309` は非空配列と各フィルタの形状しか見ていない）。

**cache-relay 側の改善余地**（このウィジェットとは別タスク・`doc/TODO.md` に追記済み）:
`eventMatchesFilter` が `authors` / `kinds` / `ids` を毎回 `includes` で線形探索している。
呼び出し側で Set を作れば authors が多いフィルタで効く。ただし上記のとおり全件 materialize が
主項なので、**先に効くのはそちら**。

### 7.1 検討した代案: グローバルフィードを取ってクライアント側で絞る

> **提案**: フォローが多い（例: 100 人以上）ときは `authors` を送らず
> `{"kinds":[1],"limit":N}` でグローバルフィードを取り、フォロー外をクライアント側の
> フィルタで捨てる。そのほうがリレーの負荷が低く、表示も速いのではないか。
>
> **結論: 既定にはできない。** ただし後述の条件下では成立するので、
> 「フォロー数で切り替える」ではなく「別戦略として明示的に選ばせる」形なら余地がある。

#### 却下の決め手は性能ではなく上限で頭打ちになること

`maxEventsPerRequest`（既定 500、embed は未指定なので既定のまま）は、
**ストレージから読んだイベントをクライアントへ送る前に `capEvents` で 500 件へ切る**
（`packages/cache-relay/src/core/message-handler.ts:352`）。この切り詰めは
**クライアント側のフォロー絞り込みより前**に起きる。

いま「リレーの最近の kind 1 のうちフォロー先が書いた割合」を **h** とすると、

- `authors` 案: 500 件の枠は**すべてフォロー先の投稿**で埋まる → `limit` どおり 50 件出る
- グローバル案: 500 件の枠はグローバルの新着で埋まり、絞り込み後に残るのは **h × 500 件**

h = 2% なら **10 件しか表示されない**。`limit` を上げても `maxEventsPerRequest` が先に効くので
解決しない。上流側も同様で、実リレーは `limit` に上限を持つのが普通
（strfry の `maxFilterLimit` など）。足りない分は `until` でページングするしかなく、
**逐次ラウンドトリップが増えて「表示が速い」の前提が崩れる**。

#### しきい値の変数が違う

「フォロー 100 人以上」はフォロー**数**を見ているが、損得を決めるのは上の **h** である。
両者は連動しない。

- 大手リレーで 100 人フォロー → h は 1% 未満。グローバル案は転送量が 100 倍近くになる
- 小規模なコミュニティリレーで 500 人フォロー → h が 50% を超えることもあり、グローバル案が有利

転送量比はおおよそ **1/h**。埋め込みウィジェットは 1 つの小さなリレーだけを指すことも多いので、
後者は空想の事例ではない。**判断するなら h を測るべきで、フォロー数では代理にならない。**

#### ローカルキャッシュではグローバル案のほうが重い

`authors + kinds` 分岐が返す行は `kind` 分岐が返す行の**部分集合**である
（`query-builder.ts:91` と `104`）。そしてフォロータイムライン用のキャッシュの中身は、
まさにそのフォロー先の投稿が大半を占める（それを取りに行っているのだから）。
したがってグローバル案は **materialize する行数が増える**。
500 回のインデックスシークを節約する代わりに、余分な行ぶんの structured clone +
`rowToEvent` + `eventRowMatchesFilter` を払うことになる。

`includes` の線形探索はたしかにグローバル案のほうが有利だが、それは Set 化で消える二次項
（§7 末尾）であり、主項の materialize は逆向きに効く。

#### ブラウザ側のコストが数十倍になる

上流イベントは**購読ごとに直列化して** ingest される
（`upstream-coordinator.ts:229` の `ingestChain`）。1 件ごとにストレージ書き込みと
LAZY 検証のキュー投入が走る。同じ 50 件を表示するために 25 倍のイベントを引くなら、
**この直列処理も 25 倍**になる。このウィジェットが動くのはブラウザのメインスレッドなので、
ここが効く。

重複排除の集合も購読あたり 10,000 id で頭打ちになる
（`maxSentIdsPerSub`、同 `97, 299-303`）。グローバルの流量はこれを流し切ってしまい、
古い id から落ちて重複配信が復活する。

#### キャッシュを汚す

これはキャッシュのプロジェクトである。グローバル案は**捨てると分かっているイベントを
IndexedDB に書き込む**。`storageMaxSize` を設定した構成では、その書き込みが
**本当に必要なフォロー先の投稿を退避させる**。プロジェクトの立て付けと逆を向いている。

#### 提案が正しい部分

大きな `authors` フィルタが重いリレー実装が存在するのは事実である（SQLite 系で
`pubkey IN (…)` が効きにくいなど）。ただし**フォロー先の kind 1 を引くのは Nostr で
最も一般的なクエリ**で、主要なリレー実装はこの形に最適化されている。
「大きな authors は避けるべき」という直感は、リレー実装によっては当たるが一般則ではない。

そして h が高い場合にグローバル案が勝つのは上記のとおり本当である。

#### 扱い

- **既定は `authors` 案のまま。** フォロー数によるモード切り替えは入れない
- グローバル案を入れるなら、`max-follows` のような自動判定ではなく
  **戦略を明示的に選ぶ属性**として、h を測ったうえで文書化する
- まず §7 の `since` を試すほうが先。母数を減らす効果は確実で、副作用も小さい

#### 妥当性を測る実験（着手前にやる）

`packages/demo-site/src/lib/benchmark.ts` の cold / warm 計測と
`e2e/src/mock-upstream-relay.ts` がそのまま使える。**h とフォロー数を独立に振る**のが要点。

- 固定: 表示したい件数 K = 50
- 振る: フォロー数 ∈ {50, 100, 500, 1000}、h ∈ {1%, 5%, 20%, 50%}
- 両案について測る:
  1. time to first event / time to EOSE（cold・warm）
  2. **絞り込み後に実際に表示できた件数**（グローバル案が h × 500 で頭打ちになることの確認）
  3. ingest したイベント総数と IndexedDB の増加量
  4. ローカルクエリだけの所要時間（`storage.getEvents` 単体）

3 と 4 を分けて測らないと、「リレーの負荷」と「ブラウザの負荷」を混同したまま結論が出る。

## 8. 鮮度ウィンドウを kind 3 にも張る（これが一番効く）

**これは新しい発見ではない。** `doc/cache-relay/upstream.md:186` に
`upstreamFreshness: { 0: 3600, 3: 600 } // プロフィールは1時間、フォローリストは10分`
という kind 3 を使った実例が既に載っており、リレー側は最初からこの用途を想定している。
未実装なのはウィジェット側だけである。

`upstreamFreshness` は replaceable kind（0 / 3 / 10000–19999）を受け付ける
（`normalizeFreshnessWindows`、`packages/cache-relay/src/core/relay-options.ts:261`）。
そして `{"kinds":[3],"authors":[<subject>]}` は `isFreshnessEligible` の条件を**すべて満たす** —
`ids` / `since` / `until` / タグ条件が無く、`kinds` は非空で全部 replaceable かつ窓あり、
`authors` も非空（`packages/cache-relay/src/upstream/freshness.ts:110`）。

したがって `relay-host.ts` の `upstreamFreshness` に kind 3 の窓を載せれば、
**2 回目以降のロードでは上流に一切問い合わせずフォローリストがキャッシュから即座に出る**。
このプロジェクトの売り（透過キャッシュ）がそのまま効く題材で、デモとしても分かりやすい。

- 属性 `follows-freshness`（秒。`0` で毎回上流へ）
- **既定値は要検討。** 既存ドキュメントの例は 600 秒（10 分）。プロフィールが 24 時間なのは
  「表示名とアバターはめったに変わらない」からで、フォローの増減はもう少し動く。
  ドキュメントの例に寄せて 600 にするか、埋め込み用途に合わせて延ばすかを決め、
  **決めた側に `upstream.md` の例も揃える**
- `RelayHostConfig` はページ共有・最初の 1 つ勝ちなので、値が食い違うと `warnOnConflict` が出る。
  既存の `profileFreshness` と同じ扱いで一貫している

**「窓を 1 つ足すだけ」では済まない点に注意。** 現状の組み立ては
`config.profileFreshness > 0 ? { 0: config.profileFreshness } : undefined` という
三項演算 1 本（`packages/timeline-embed/src/lib/relay-host.ts:192`）で、そのまま kind 3 を
足すと 2 つの壊れ方をする。

- `profileFreshness = 0`（プロフィールは毎回上流へ）かつ `followsFreshness = 3600` のとき、
  窓レコード全体が `undefined` になり kind 3 の窓も消える
- `followsFreshness = 0` を `{ 3: 0 }` として渡すと `normalizeFreshnessWindows` が
  **throw** し（`relay-options.ts:266-270`、窓は正の有限数のみ）、`relay.connect()` ごと
  失敗してウィジェットが起動しない

→ kind ごとに条件付きでレコードを組む形へ直す。`relay-host.ts:70-77` のコメントが
まさにこの罠（「非正の窓はリレーが拒否する = 起動が落ちる。それは "無効化" の綴りとして
驚きがある」）を既に説明している。`follows-freshness` の入力側も `parseFreshness`
（`timeline-config.ts:92-106`）と同じ規約 —「負値は typo として警告して既定値、`0` は無効化」—
に揃える。

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

**そして §10 の割り切りが、この影響の寿命を延ばす。** 遅延検証は 5 秒間隔で走り
（`DEFAULT_LAZY_VALIDATE_INTERVAL`、`relay-host.ts:38`）、不正イベントを実際にストレージから
削除する（`lazy-validator.ts:152-155`）ので、**キャッシュの汚染そのものは数秒で自己修復する**。
ところが §10 で「kind 3 の REQ は取得後に閉じる／authors は張り替えない」と決めているため、
**偽リストから組まれた `authors` はセッション終了までそのまま残り、リレー側が偽装を検出して
削除しても画面は訂正されない**。カード 1 枚なら消えて終わりだったものが、ここでは
「間違った母集団のまま動き続ける」に変わる。

- **今回**: README の制約として明記する
- **要判断（初回スコープに入れるか）**: kind 3 の検証状態を `fetchValidationStatuses` で
  ポーリングし、`invalid`（= 削除された）になったらタイムラインを畳んでエラーを出す。
  既存の再ポーリング機構（`hasPending` を使う `refreshValidationStatuses`、
  `timeline-controller.ts:476-506`）がそのまま流用できるので、追加コストは小さい。
  上記のとおり「検出はされるのに表示は直らない」という状態は説明しづらいため、
  **将来送りにせず初回で入れる方に傾く**
- **将来**: `IMMEDIATELY` 検証を kind 3 だけにかける経路を用意する

## 12. プロフィール取得との相互作用

フォロータイムラインは著者が最大 `max-follows` 人に散る。カードが見えるたびに 1 人 1 REQ を
出す既存の仕組み（並列 4 本）は、スクロールで次々に新しい著者が現れるためキューが伸びる。

既定 `limit=50` なら画面に出る著者は最大 50 人なので実際には問題にならない。
`limit` を大きくした埋め込みでは「名前が遅れて出る」体感になる。**挙動は変えず README に記載**。

## 13. 状態表示

`TimelineState` に解決フェーズを足す。

```ts
follows?: {
  /** invalid = 署名検証に落ちて削除された（§11） */
  status: 'resolving' | 'ready' | 'missing' | 'invalid';
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
- `invalid`: 「フォローリストの署名検証に失敗しました」（タイムラインは畳む。§11）
- `ready` かつ `truncated > 0`: `debug` のときだけ「N 人中 500 人を表示」

## 14. 属性一覧（案）

| 属性 | 内容 | 既定 |
|---|---|---|
| `pubkey` | 誰のフォローを辿るか。`npub` / `nprofile` / hex | **必須** |
| `relays` | 上流リレー URL（カンマ区切り） | なし |
| `kinds` | 並べるイベント種別 | `1` |
| `limit` | 取得件数 | `50` |
| `max-follows` | authors に載せるフォロー先の上限 | `500`（要検討・§7） |
| `include-self` | 本人の投稿も含める | `true` |
| `follows-freshness` | kind 3 のキャッシュを上流に問い合わせ直さずに使う秒数 | 要検討（§8） |
| `db-name` / `profile-freshness` / `debug` / `show-avatars` / `show-media` | 既存 `<nostr-timeline>` と同じ | 同じ |

`authors` と `filters` は**持たない**。`pubkey` と意味が衝突するため。

`pubkey` の解釈は `filter-json.ts` の `toPubkeyHex` と同じ規則にする（hex / `npub` / `nprofile`）。
ただし **`toPubkeyHex` は現在エクスポートされていない**（`filter-json.ts:56` に `export` が無く、
`lib/index.ts:32` も `MAX_FILTERS` と `parseFilterList` しか再エクスポートしていない）ので、
export を足すか共通モジュールへ切り出す必要がある。

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
2. `lib/one-shot-request.ts` を**新規に追加**（§5 のとおり、既存プロフィール取得の載せ替えは
   同時にやらない。やるなら独立した変更として先に緑にする）
3. `TimelineController.start()` に `FilterSource` を受けさせる（§4 の後始末込み）
4. `TimelineView.svelte` を抽出し、`<nostr-follow-timeline>` を追加
5. `relay-host.ts` の `upstreamFreshness` 組み立てを kind ごとの条件付きへ直し、
   `followsFreshness` を足す（§8）
6. iframe ページの分岐・README・demo-site への追加
7. e2e

## 17. 未解決（実装時に決める）

- **`max-follows` の既定値**。REQ サイズではなく「キャッシュ上の kind 1 蓄積量 × フォロー数」で
  見積もる（§7）。切り捨てを先頭から採るか末尾から採るかも同時に決める
- **タイムラインフィルタに `since` を入れるか**（§7）。全件 materialize の母数を直接削れるが、
  入れると `isFreshnessEligible` を通らなくなるので kind 1 側限定
- **グローバルフィード + クライアント側フィルタ案を戦略として残すか**（§7.1）。
  既定にはしない結論だが、h（リレーの新着 kind 1 に占めるフォロー先の割合）が高い
  小規模リレー向けには成立する。入れるなら §7.1 の実験を先に回す
- **`follows-freshness` の既定値**。`doc/cache-relay/upstream.md:186` の例は 600 秒。
  決めた側にその例も揃える（§8）
- **kind 3 の `invalid` 検出を初回スコープに入れるか**（§11）
- **iframe を 1 ページの分岐にするか 2 ページに分けるか**（§3）
- 要素名: `<nostr-follow-timeline>` / `<nostr-home-timeline>`
- `truncated > 0` の表示を `debug` 限定にするか常時出すか
