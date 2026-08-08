# @nostr-cache/timeline-embed

他サイトに埋め込める Nostr タイムラインウィジェット。ブラウザ内で動く
`@nostr-cache/cache-relay` を上流リレーの手前に**透過キャッシュ**として挟み、
イベントを IndexedDB に貯めながら表示します。

要素は 2 つあります。

| 要素 | 内容 |
|---|---|
| `<nostr-timeline>` | フィルタを直接書く。kind / 著者 / `filters` JSON を指定する |
| `<nostr-follow-timeline>` | **人を 1 人指定すると、その人のホームタイムラインが出る**（[下記](#フォロータイムライン)） |

- 初回は上流リレーから取得、2 回目以降はローカルキャッシュから即座に表示
- `debug` を付けると各イベントに `cache` / `upstream` バッジを表示（キャッシュが効いているのを
  目で確認するための動作確認用。既定では表示しません）
- 署名検証はリレーがバックグラウンドで実行し、検証済みイベントに ✓ を表示
  （クライアント側で暗号処理をしない）
- ページ内リレーへの接続管理は [rx-nostr](https://penpenpng.github.io/rx-nostr/) に委譲。
  接続が切れても自動再接続し（rx-nostr 既定の指数バックオフ + jitter・5 回）、開いていた REQ を張り直すので、
  リレーが作り直されてもタイムラインとプロフィール取得が復帰します
  （再接続中は「リレーに再接続しています…」を表示）
- アバター・表示名・`@handle` を kind 0（プロフィール）から表示。kind 0 は replaceable として
  同じキャッシュに載り、`upstreamFreshness` の鮮度ウィンドウ（既定 24 時間・
  `profile-freshness` で変更可）が効くため、リロード後は上流に問い合わせず即座に出ます
- 返信・引用（`e` / `q` タグ）がある投稿には参照チップを表示（参照先の本文は取得しません）
- フォローリスト（kind 3）も replaceable として同じキャッシュに載り、鮮度ウィンドウ
  （既定 10 分・`follows-freshness` で変更可）が効くため、`<nostr-follow-timeline>` の
  2 回目以降のロードは**上流に問い合わせずフォローリストがキャッシュから即座に出ます**

公開デモ: <https://ocknamo.github.io/nostr-cache/>

## 埋め込み方

### iframe（埋め込み先から完全に隔離）

```html
<iframe
  src="https://ocknamo.github.io/nostr-cache/embed/?relays=wss://nos.lol&kinds=1&limit=50"
  style="width: 100%; height: 480px; border: 0"
  title="Nostr timeline"
></iframe>
```

ウィジェットは iframe 自身の `globalThis` でリレーを動かすため、**埋め込み先ページには
一切触れません**。クエリパラメータは下の属性一覧と同名です。

高さを内容に合わせたい場合は、埋め込みページが送る `postMessage` を拾ってください。
**送信元が自分の iframe であることを必ず確認してください**（ページ内の他フレームも
`message` を送れるため）:

```js
window.addEventListener('message', (event) => {
  // 自分が埋め込んだ iframe 以外からのメッセージは無視する
  if (event.source !== iframe.contentWindow) return;
  if (event.data?.type === 'nostr-timeline:height') {
    iframe.style.height = `${event.data.height}px`;
  }
});
```

### Web Component（埋め込み先ページ内で動作）

```html
<script src="https://ocknamo.github.io/nostr-cache/nostr-timeline.js"></script>

<nostr-timeline relays="wss://nos.lol" kinds="1" limit="50"></nostr-timeline>
```

こちらは埋め込み先ページ内で直接動きます。**`globalThis.WebSocket` を差し替えて**
対象 URL（`ws://nostr-cache.invalid`）への接続だけを横取りするため、ページ内の他の
Nostr クライアントとキャッシュを共有できます。対象外の URL への接続は元の実装へ
そのまま委譲されるので、他の通信には影響しません。詳細は下の「制約」を参照。

## 属性 / クエリパラメータ（`<nostr-timeline>`）

`<nostr-follow-timeline>` の属性は[フォロータイムライン](#フォロータイムライン)を参照してください。

| 名前 | 内容 | 既定値 |
|---|---|---|
| `relays` | 上流リレー URL（カンマ区切り）。空ならキャッシュ済みイベントのみ表示 | なし |
| `filters` | NIP-01 フィルタ配列の JSON。指定すると `kinds` / `authors` / `limit` は無視される（[下記](#filters-で細かく絞り込む)） | なし |
| `kinds` | イベント種別（カンマ区切り） | `1` |
| `authors` | 著者 pubkey（hex・カンマ区切り） | 指定なし |
| `limit` | 取得件数 | `50` |
| `db-name` | IndexedDB のデータベース名 | `nostr-cache-embed` |
| `profile-freshness` | プロフィール（kind 0）のキャッシュを上流に問い合わせ直さずに使う秒数。`0` で毎回問い合わせる | `86400`（24 時間） |
| `follows-freshness` | フォローリスト（kind 3）の同じ設定。**この要素自身は kind 3 を取得しません** — 同じページに `<nostr-follow-timeline>` を置く場合に設定を揃えるためのものです（[下記](#フォロータイムライン)） | `600`（10 分） |
| `debug` | 動作確認用。付けると各投稿に `cache` / `upstream` バッジを表示する | なし（非表示） |
| `show-origin` | **非推奨**。`debug` の旧称。`true` なら `debug` と同じくバッジを表示する（`false` は既定と同じ） | なし（非表示） |
| `show-avatars` | `false` でアバター画像を隠す（表示名は取得したまま） | `true` |
| `show-media` | `false` で本文中の画像・動画・音声の埋め込みを止める（URL はリンクとして残る） | `true` |
| `actions` | 各投稿の下に並べるボタンの JSON 配列（[下記](#投稿ごとのアクションボタン仕組みのみ)） | なし（ボタンを出さない） |
| `material-icons` | ボタンのアイコンを [Material Symbols](https://fonts.google.com/icons) で描画する。`outlined` / `rounded` / `sharp`（値なしは `outlined`） | なし（`icon` は文字そのまま） |
| `material-icons-font` | `none` で Google Fonts の読み込みを止める（埋め込み先ページが自前で読み込む場合） | `google`（Google Fonts から読み込む） |

`profile-freshness` は iframe（`&profile-freshness=3600`）と Web Component
（`profile-freshness="3600"`）のどちらでも同じように指定できます。プロフィールの更新を
早く反映したい場合は短く、上流への問い合わせをさらに減らしたい場合は長くしてください。
**1 ページにリレーは 1 つ**なので、複数の `<nostr-timeline>` を置く場合はこの値も
揃えてください（揃っていないと最初のウィジェットの値が採用され、警告が出ます）。

`debug` は値なしの `debug`（iframe なら `&debug`）でも `debug="true"` でも有効になります。
`cache` / `upstream` バッジは**キャッシュが効いていることを埋め込む側が確認するための表示**なので、
既定では出しません。実際のサイトに埋め込むときは付けないでください。

旧称の `show-origin` も引き続き動きます（コンソールに非推奨の警告を 1 回出します）。
`show-origin="true"` は `debug` と同じくバッジを表示します。

不正な値（WebSocket でない URL、整数でない kind、負の `profile-freshness` など）は
警告を出して無視されます（既定値のまま動作します）。
**https のページからは `ws://` の上流リレーを指定できません**（ブラウザが混在コンテンツ
として遮断するため）。`wss://` を使ってください。

## フォロータイムライン

`<nostr-follow-timeline>` は **指定した pubkey が NIP-02（kind 3・フォローリスト）で
フォローしている人たちの投稿**を並べます。`<nostr-timeline>` が「フィルタを直接書く」ものなのに対し、
こちらは「人を 1 人指定すると、その人のホームタイムラインが出る」ものです。

```html
<script src="https://ocknamo.github.io/nostr-cache/nostr-timeline.js"></script>

<nostr-follow-timeline
  pubkey="npub1..."
  relays="wss://nos.lol,wss://relay.damus.io"
></nostr-follow-timeline>
```

iframe は**別のページ**（`embed/follow/`）です:

```html
<iframe
  src="https://ocknamo.github.io/nostr-cache/embed/follow/?pubkey=npub1...&relays=wss://nos.lol&limit=50"
  style="width: 100%; height: 480px; border: 0"
  title="Nostr follow timeline"
></iframe>
```

高さの `postMessage` は `embed/` とまったく同じ仕組みです（同じスクリプトを共有しています）。
なお先頭カードの日付ツールチップは下向きに開くため、**カードが少ない埋め込みでは
それを開いている間だけ報告する高さが数十 px 伸びます**（閉じれば戻ります）。

入口を分けているのは、要素を分けたのと同じ理由です。この要素には `authors` も `filters` も
**ありません**（`pubkey` と意味が衝突するため）。1 つのページで両方を受けると、
`?pubkey=…&filters=…` のような URL が「`filters` が黙って無視される」形で通ってしまいます。

### 動作

購読は 2 段階です。

1. `{"kinds":[3],"authors":["<pubkey>"]}` でフォローリストを取得する
2. その `p` タグから `authors` を組み立て、`{"kinds":[1],"authors":[…],"limit":50}` を購読する

**フォローリストが取得できなかった場合・`p` タグが 0 件だった場合は、購読を張らずに
「フォローリストが見つかりませんでした」を表示します。** `authors` の無い kind 1 フィルタへ
フォールバックすることはありません（上流リレー群にグローバルフィード全体を要求することになり、
埋め込み先のページが意図せず帯域を焼くため）。

### 属性 / クエリパラメータ

| 名前 | 内容 | 既定値 |
|---|---|---|
| `pubkey` | 誰のフォローを辿るか。hex / `npub` / `nprofile` | **必須** |
| `relays` | 上流リレー URL（カンマ区切り） | なし |
| `kinds` | 並べるイベント種別（カンマ区切り） | `1` |
| `limit` | 取得件数 | `50` |
| `max-follows` | `authors` に載せるフォロー先の上限（病的なリストへの安全弁） | `2000` |
| `include-self` | 本人の投稿も含める（`show-avatars` と同じ規約で、**`false` 以外はすべて有効**。`0` でも off にはなりません） | `true` |
| `since-days` | 直近 N 日の投稿だけを対象にする | なし（無効） |
| `follows-freshness` | kind 3 のキャッシュを上流に問い合わせ直さずに使う秒数。`0` で毎回問い合わせる | `600`（10 分） |
| `db-name` / `profile-freshness` / `debug` / `show-avatars` / `show-media` / `actions` / `material-icons` / `material-icons-font` | `<nostr-timeline>` と同じ | 同じ |

`pubkey` は**既定値で動かしようがない唯一の属性**なので、他の属性のような
「警告して既定値で続行」はしません。不正なら購読を張らず「pubkey が不正です」を表示します。

`max-follows` の既定 `2000` は**チューニング用のつまみではなく安全弁**です。実測では
上流リレー 2 本とも 982 人ぶんの `authors` を問題なく捌き、500 人に減らしても
レイテンシは約 10ms しか変わりませんでした。上限を低くすると、速くなるのではなく
**「その人のホームタイムライン」として間違ったものが出る**ことになります。
切り捨てはリストの**先頭から**採ります（NIP-02 は新しいフォローを末尾に追記すべきと
していますが、実クライアントが守っている保証がないため順序に意味を仮定していません）。
`debug` を付けると、切り捨てが起きたときに「N 人中 M 人を表示しています」を出します。

`since-days` は**既定で無効**です。付けるとローカルクエリの走査範囲が狭まりますが、
**フォロー先が静かなときにタイムラインが空になり**、読者には「投稿が無いのか、
窓で切れたのか」が区別できません。入れる場合も 30 日程度の長めの窓から始めてください。

### 制約（フォロータイムライン固有）

- **フォローリストの署名が未検証のまま authors を組みます。** リレーは遅延検証で動くため、
  なりすまし kind 3（新しい `created_at` を持つもの）が上流から返ると、
  **表示される母集団そのもの**が別人の人選になります。カード 1 枚が混じるのとは
  影響の桁が違う点に注意してください。
  緩和として、取得した kind 3 がキャッシュに残っているかをポーリングし、**消えていたら
  タイムラインを畳んで「フォローリストがキャッシュから失われたため、表示を中止しました」を
  表示**します。リレーが署名不正と判断して削除した場合はこれで拾えます。
  ただし**「署名検証に失敗した」とは言いません** — リレーは理由を区別せず「無い」としか
  答えないためです（不正削除のほか、NIP-09 による削除、`storageMaxSize` 下での退避、
  ストレージ読み取り失敗も同じ `unknown` になります）。
  なお `validated`（検証済み）になった時点で監視は終了します
- **リレーヒントは使いません。** kind 3 の `p` タグ 2 番目の要素にも NIP-65（kind 10002）にも
  リレー URL が入りますが、上流リレー集合はページ共有・起動時固定なので実行時に変えられません
- **画面を開いたままフォローリストの更新は反映されません。** kind 3 の購読は取得後に閉じます。
  開いたまま `authors` を張り替えるとタイムラインの REQ を作り直すことになり、画面が飛ぶためです
- **kind 3 を一度も公開していない pubkey では鮮度ウィンドウが効きません。** キャッシュに
  一度も入らないものは「新鮮」と判定しようがないため、毎回 1 往復 + 最大 5 秒待って
  「見つかりませんでした」に落ちます（表示は正しいですが、上流に定期的な負荷がかかります）
- **`kinds` に `6`（リポスト）を入れると表示が壊れます。** 実クライアントのホーム
  タイムラインにはリポストが並びますが、このウィジェットのカードは kind 6 を解釈しません。
  kind 6 の `content` は空かリポスト元イベントの JSON 文字列なので、**空カードか生 JSON**が出ます
- **NIP-51（kind 30000 のフォローセット）は対象外**です。addressable なので鮮度ウィンドウの
  対象にもなりません
- `storageMaxSize` を設定した構成では kind 3 が退避されると毎回上流へ戻ります
  （`cachePriority: { kinds: [3] }` で守れます。現状 embed は `storageMaxSize` を設定していません）

## `filters` で細かく絞り込む

`kinds` / `authors` / `limit` はカンマ区切りの手軽さと引き換えに、NIP-01 のフィルタの
一部（`since`・`until`・`ids`・タグフィルタ）に届きませんし、フィルタを 1 つしか
書けません。`filters` にはフィルタ配列を JSON でそのまま書けます。

```html
<nostr-timeline filters='[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]'></nostr-timeline>
```

配列内のフィルタは **1 本の REQ** として送られるので、どれかに一致したイベントが
同じタイムラインに並びます。

```js
// テキストノート（kind 1）
'[{"kinds":[1],"limit":10}]';

// 特定の著者の投稿
'[{"kinds":[1],"authors":["npub1...","npub2..."],"limit":5}]';

// 特定のハッシュタグが付いた投稿
'[{"kinds":[1],"#t":["nostr","bitcoin"],"limit":10}]';

// 直近 1 時間の投稿
'[{"kinds":[1],"since":' + (Math.floor(Date.now() / 1000) - 3600) + ',"limit":20}]';

// あるノートへの返信
'[{"kinds":[1],"#e":["note1abc..."],"limit":10}]';

// 複数の kind
'[{"kinds":[1,6,7],"limit":15}]';
```

- HTML 属性なので、JSON はシングルクォートで囲んでください。iframe で使う場合は
  URL エンコードします（`embed/?filters=%5B%7B%22kinds%22%3A%5B1%5D%7D%5D`）。
- `authors` と `#p` は hex でも `npub` / `nprofile` でも、`ids` と `#e` は hex でも
  `note` / `nevent` でも書けます（内部で hex に変換して送ります）。
  それ以外のタグ（`#t` など）の値はそのまま渡します。
- `limit` を書かなかったフィルタには既定の `50` が入ります。
- フィルタは**最大 10 個**まで。11 個目以降は警告を出して無視します。
- リレーが解釈できないフィルタは REQ ごと拒否されてしまうため、こちら側で先に落とします。
  ただし何を落とすかは場合によって違い、**キーだけ消える場合とフィルタごと消える場合があります**:
  - **未対応のキー**（`search` など）は、そのキーだけ無視してフィルタ自体は残します。
  - **型の合わない値**（`"limit":"10"`、`"kinds":1`、`"#t":[1]` など）は、
    **そのフィルタごと**捨てます。`limit` を数値でなく文字列で書いた、といった
    書き間違い 1 つでそのフィルタが丸ごと消えるので注意してください。
  - **絞り込み条件（`authors` など）の値が全滅した**フィルタも、条件だけ消えて
    検索範囲が広がってしまわないよう、そのフィルタごと捨てます。
- JSON が壊れている、あるいは全フィルタが使えなかった場合は
  `kinds` / `authors` / `limit`（未指定なら kind 1・50 件）に戻ります。

## 見た目のカスタマイズ

スタイルは Shadow DOM に閉じているので、埋め込み先の CSS と衝突しません。
調整は CSS カスタムプロパティで行います:

```css
nostr-timeline {
  --nt-bg: #0f1419;
  --nt-fg: #e6edf3;
  --nt-card-bg: #161b22;
  --nt-border: #30363d;
  --nt-muted: #8b949e;
  --nt-radius: 8px;
  --nt-gap: 8px;
  --nt-cache-bg: #10331f;
  --nt-cache-fg: #4ade80;
  --nt-upstream-bg: #1b2330;
  --nt-upstream-fg: #93a4bd;

  /* カード（アバター + 名前 + 参照チップ） */
  --nt-separator: #30363d;      /* カード間の区切り線。既定は --nt-border */
  --nt-card-padding: 10px 12px;
  --nt-card-max-height: 420px;  /* 1 投稿の高さの上限。none で content 任せ */
  --nt-scrollbar: #8b949e;      /* 上限を超えた投稿のスクロールバー。既定は --nt-muted */
  --nt-avatar-size: 40px;
  --nt-avatar-radius: 8px;
  --nt-avatar-gap: 10px;        /* アバターと本文の間隔 */
  --nt-name-fg: #e6edf3;        /* 表示名 */
  --nt-handle-fg: #8b949e;      /* @handle。既定は --nt-muted */
  --nt-quote-bar: #4a7dff;      /* 返信 / 引用チップの縦線 */
  --nt-tip-bg: #0f1419;         /* 日付ツールチップの背景 */
  --nt-tip-fg: #ffffff;         /* 日付ツールチップの文字色 */
  --nt-list-padding-top: 16px;  /* リスト先頭の余白 */
  /* --nt-tip-clearance: 48px;     旧称。指定があればそのまま余白として効きます */
  --nt-unverified-opacity: 0.6; /* 署名未検証カードの不透明度。1 で区別しない */

  /* アクションボタン（--nt-action-* は actions を指定したときだけ効く） */
  --nt-actions-justify: flex-end; /* 既定は右寄せ。space-between で横いっぱい */
  --nt-action-gap: 8px;
  --nt-action-padding: 6px 10px;
  --nt-action-size: 1rem;       /* 文字アイコン・ラベルの大きさ */
  --nt-action-icon-size: 20px;  /* Material Symbols の大きさ */
  --nt-action-fg: #8b949e;      /* 既定は --nt-muted */
  --nt-action-hover-fg: #58a6ff;
  --nt-action-hover-bg: rgb(88 166 255 / 12%);
  --nt-material-fill: 0;        /* 1 で塗りつぶしアイコン */
  --nt-material-weight: 400;    /* 100〜700 */
  --nt-material-font: 'Material Symbols Outlined'; /* 自前フォントを使う場合 */

  /* 本文（リンク・メンション・添付） */
  --nt-link-fg: #58a6ff;        /* 本文中のリンク */
  --nt-mention-fg: #58a6ff;     /* nostr: メンション */
  --nt-mention-bg: transparent;
  --nt-media-max-height: 300px; /* 添付画像・動画の高さの上限。カード上限に収まる値 */
  --nt-media-radius: 10px;
  --nt-media-bg: #161b22;       /* 読み込み中の添付の背景 */
}
```

日時は年月日を省いた `12:33:45` 形式です（名前から時刻までを必ず一行に収めるため）。
省いた日付は時刻をホバー、またはタップすると**ツールチップ**で表示されます
（キーボードでも開けます。Esc で閉じます）。`<time datetime>` には ISO 8601 の
完全な日時が入っているので、機械可読な値はそのまま取得できます。ツールチップは
時刻の上に開きますが、**先頭カードだけは下向きに開きます**（上に開く場所が無いため）。
上部の余白は `--nt-list-padding-top`（既定 16px）で調整します（旧称
`--nt-tip-clearance` も引き続き読みます）。

カードは既定で**区切り線で連なるリスト**です（一般的な Nostr クライアントの見え方）。
`--nt-gap` を指定すると、従来どおり間隔の空いたブロックとして並びます。

### 1 投稿の高さの上限

**1 投稿の高さは既定で 420px までです**（`--nt-card-max-height`）。
極端に長い投稿がタイムラインを埋め尽くしてしまわないよう、上限を超えた分は
**その投稿の中だけでスクロール**します。スクロールするのは本文だけで、
名前・時刻・返信/引用チップ・アクションボタンの行はカード内に留まります。

- 上限はパディングを含めた**カード全体の高さ**です（`box-sizing: border-box`）。
  `--nt-card-max-height: none` で上限なし（従来どおり本文の長さだけカードが伸びる）に戻せます。
- 溢れている投稿だけがスクロール領域になります。その場合のみ
  キーボードで到達できるよう `tabindex="0"` と `role="group"` が付き（WCAG 2.1.1）、
  下端に「まだ続きがある」ことを示すフェードが出ます（最下部まで送ると消えます）。
  収まっている投稿には何も付きません（タブ移動の邪魔になるため）。
  `role="region"` ではなく `group` なのは、名前付きの region がランドマークになり、
  長文が並ぶタイムラインでスクリーンリーダーのランドマーク一覧が同名項目で
  埋まってしまうためです。
- スクロール領域は `part="note"` で公開しています。スクロールバーは
  `scrollbar-width: thin` と `--nt-scrollbar`（色）で調整できます。
- 添付画像・動画の高さの上限 `--nt-media-max-height` の既定値（300px）は、
  **カードの上限（420px）の中にヘッダーとアクション行ごと収まる**ように選んでいます。
  写真 1 枚の投稿は縮小して全体を表示します（画像はスクロールさせるより
  縮めて全体を見せるほうがよいため）。上限付きのカードでこれを大きくしても
  スクロールバーが増えるだけなので、大きな画像を出したい場合は
  `--nt-card-max-height` も一緒に引き上げる（または `none` にする）でください。

## 本文の描画

本文はプレーンテキストではなく、次のものを解釈して描画します。

| 対象 | 描画 |
|---|---|
| `http(s)` の URL | `<a target="_blank" rel="noopener noreferrer nofollow">` |
| 画像 URL（`.jpg` `.jpeg` `.png` `.gif` `.webp` `.avif`） | `<img>`。クリックで原寸を新規タブに開く |
| 動画 URL（`.mp4` `.webm` `.ogv` `.mov`） | `<video controls preload="none">` |
| 音声 URL（`.mp3` `.ogg` `.oga` `.wav` `.m4a`） | `<audio controls preload="none">` |
| `nostr:npub1…` / `nprofile` / `note` / `nevent` / `naddr`（`nostr:` 無しの裸の形も可） | 短縮表示のチップ。**リンクにはしません** |

**HTML は一切組み立てません。** 解析結果は「元の文字列のどの範囲が何か」というトークン列で、
描画は Svelte の通常の補間だけで行います（`{@html}` も `innerHTML` もこのパッケージには
存在しません）。したがって `javascript:` や `data:` の URL は**リンクにならずただの文字**として
残ります。双方向制御文字（bidi override）は、リンクの見た目を偽装できてしまうため本文から
除去します（改行は `white-space: pre-wrap` の表示に必要なので残します）。

添付は本文の下にまとめて表示し、その URL は本文中から取り除きます。1 投稿あたりの添付は
先頭 8 件までで、超えた分は普通のリンクとして本文に残ります。

`nostr:` メンションを**リンクにしないのは意図的**です。ウィジェットは Nostr クライアントでは
ないので、送り先として妥当な URL を持っていません。**すでにタイムライン上にいる著者**への
メンションは `@表示名` に解決されますが、それ以外は短縮 npub のままです
（メンション先のプロフィールを追加取得すると、カードごとに購読が増えるため行いません）。

## 投稿ごとのアクションボタン（仕組みのみ）

各投稿の下にボタンの行を出せます。**ウィジェット自身はボタンを 1 つも持ちません** —
用意してあるのは「置き場所」と「押されたことを伝える経路」だけです。返信・リポスト・
いいね・Zap はいずれも署名（＝鍵）が要る操作で、このウィジェットは鍵を持たない
読み取り専用の表示器だからです。押されたあと何をするかは埋め込む側が決めます。

`actions` を指定しなければ行そのものが描画されないので、既存の埋め込みの見た目は変わりません。

### HTML から（Web Component）

```html
<nostr-timeline
  relays="wss://nos.lol"
  actions='[
    {"id":"reply","label":"返信","icon":"💬"},
    {"id":"repost","label":"リポスト","icon":"🔁"},
    {"id":"like","label":"いいね","icon":"♡"},
    {"id":"zap","label":"Zap","icon":"⚡"},
    {"id":"share","label":"共有","icon":"↗"}
  ]'
></nostr-timeline>

<script>
  document.querySelector('nostr-timeline').addEventListener('nostr-timeline:action', (e) => {
    // e.detail = { actionId: 'zap', event: <NostrEvent> }
    console.log(e.detail.actionId, e.detail.event.id);
  });
</script>
```

イベントは `bubbles` + `composed` なので、祖先要素でまとめて受け取ることもできます。
`detail.event` は**そのカードが表示しているイベントのコピー**です（ウィジェット内部の
状態そのものは渡しません）。

### JS から（プロパティで渡す）

属性は文字列なので関数を書けません。プロパティに配列を代入すると `onSelect` を持てます。

```js
document.querySelector('nostr-timeline').actions = [
  { id: 'like', label: 'いいね', icon: '♡', onSelect: ({ event }) => like(event) },
];
```

`onSelect` を呼んだあとに `nostr-timeline:action` も発火します（両方受け取れます）。
`onSelect` が例外を投げても、コンソールに出したうえでイベントの発火は続けます。

### iframe から

クエリパラメータ（URL エンコードした JSON）で宣言し、押下は `postMessage` で戻ります。
高さ通知と同じ経路なので、**送信元が自分の iframe であることを必ず確認してください**:

```js
window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow) return;
  if (event.data?.type === 'nostr-timeline:action') {
    // event.data = { type, actionId, event: <NostrEvent> }
  }
});
```

### ボタンの定義

| キー | 内容 |
|---|---|
| `id` | **必須**。押下を見分ける識別子。DOM イベントと `postMessage` にはこれが載ります |
| `label` | **必須**。アクセシブル名（`aria-label`、アイコンボタンでは `title` も）。アイコンだけのボタンでも省略できません |
| `icon` | 表示する文字（絵文字など）。Material Symbols を有効にした場合は**アイコン名**（`favorite` など）。無い場合は `label` をそのまま文字として出します |
| `iconType` | `text` / `material`。`material-icons` の設定をこのボタンだけ上書きする（絵文字とアイコン名の混在用） |
| `showLabel` | `true` でアイコンの横に `label` も表示する |
| `disabled` | `true` で押せないボタンにする |
| `onSelect` | 押下時に呼ぶ関数（プロパティで渡す場合のみ） |

- `id` と `label` が揃わないエントリは**そのボタンだけ**警告を出して捨てます。
- `id` が重複した場合は先勝ちです（受け取り側が区別できないため）。
- ボタンは**1 投稿あたり 8 個まで**。行は折り返さない前提の 1 行です（9 個目以降は 1 回警告を出して切り捨て）。
- JSON が壊れている、配列でない場合は警告を出してボタン無しになります。

### Material Symbols アイコン

`material-icons` を付けると、`icon` は文字ではなく
[Material Symbols](https://fonts.google.com/icons) の**アイコン名（リガチャ）**として扱われます。

```html
<nostr-timeline
  relays="wss://nos.lol"
  material-icons="rounded"
  actions='[
    {"id":"reply","label":"返信","icon":"chat_bubble"},
    {"id":"repost","label":"リポスト","icon":"repeat"},
    {"id":"like","label":"いいね","icon":"favorite"},
    {"id":"zap","label":"Zap","icon":"bolt"},
    {"id":"share","label":"共有","icon":"share"}
  ]'
></nostr-timeline>
```

- 変種は `outlined`（既定）/ `rounded` / `sharp`。値なしの `material-icons` でも有効です。
- **フォントは既定で Google Fonts から読み込みます**（`<link>` を `document.head` に 1 回だけ挿入）。
  Shadow DOM 内の `@font-face` はどのブラウザでも無視されるため、
  ウィジェット内部だけで完結させることができないからです。
  **この読み込みは Google への第三者リクエストで、閲覧者の IP アドレスが Google に渡ります。**
  埋め込み先ページが自前でフォントを読み込む場合（セルフホストを含む）は
  `material-icons-font="none"` を指定してください。
- フォントが読み込まれるまでの間、アイコンは `favorite` のような**アイコン名の文字列として表示されます**。
- 絵文字と混ぜたい場合は、そのボタンだけ `"iconType":"text"` を指定します
  （逆に、全体が文字アイコンのときに 1 つだけ `"iconType":"material"` にもできます）。
- `--nt-material-fill`（0/1）・`--nt-material-weight`（100〜700）で塗りと太さを変えられます。

### 見た目の調整

- CSS 変数: `--nt-actions-justify`（既定 `flex-end` = 右寄せ。`space-between` で横いっぱいに広げる）、
  `--nt-action-gap` / `--nt-action-padding` / `--nt-action-size` / `--nt-action-icon-size` /
  `--nt-action-fg` / `--nt-action-hover-fg` / `--nt-action-hover-bg`（[上記](#見た目のカスタマイズ)）
- Shadow parts: 行全体が `::part(actions)`、ボタンが `::part(action)`、
  **個別のボタンが `::part(action-<id>)`**（例: `nostr-timeline::part(action-like) { color: crimson }`）

## 制約

- **署名未検証のイベントも表示されます。** ウィジェットはリレーを遅延検証
  （`validateEventsType: 'LAZY'`）で起動します。イベントは受信時点では検証されずに
  保存・表示され、バックグラウンド検証（既定 5 秒間隔）が署名不正と判断したものを
  あとから削除します。したがって **✓ が付いていないイベントは「検証待ち」か
  「検証に失敗して削除される直前」のどちらか**で、その間は画面に残ります。
  未検証のカードは**半透明**（既定 60%）で表示し、検証が通った時点で不透明になります。
  読み込み直後は全カードが半透明で、数秒かけて順に濃くなるのが正常な挙動です。
  表示内容の真正性が重要な用途では、✓ が付いた（＝半透明でない）イベントだけを
  信頼してください
  （この方式は、クライアント側で暗号処理をせずに済ませるための意図的なトレードオフです）。
  半透明表示をやめる場合は `--nt-unverified-opacity: 1` を指定してください（✓ は残ります）。
  **半透明の間は文字のコントラストが下がります**（`--nt-muted` の二次テキストは
  WCAG AA の 4.5:1 を下回ります）。コントラストを優先する場合も
  `--nt-unverified-opacity: 1` にしてください
- **アバター画像は上流リレー由来の任意の URL から読み込まれます。** `picture` は上流が返した
  プロフィールの中身そのままで（`http:` / `https:` 以外のスキームは破棄しますが、ホストは
  制限しません）、画像を読みに行く時点で**閲覧者の IP アドレスとブラウザ情報がその画像ホストに
  渡ります**。`referrerpolicy="no-referrer"` を付けているので埋め込み先の URL は送られませんが、
  接続自体は避けられません。気になる場合は `show-avatars="false"` を指定してください
  （表示名と `@handle` は引き続き表示されます）
- **本文中の添付も同様に、投稿者が書いた任意のホストから読み込まれます。** 画像には
  アバターと同じく `referrerpolicy="no-referrer"` と遅延読み込みを付けていますが、
  **閲覧者の IP アドレスはその配信元に渡ります**。動画・音声には `referrerpolicy` に
  相当する属性が HTML に無いため、再生すると埋め込み先 URL も送られます
  （`preload="none"` なので、**再生ボタンを押すまで通信は発生しません**）。
  避けたい場合は `show-media="false"` を指定してください。URL はリンクとして残るので、
  閲覧者が自分で開くことは引き続きできます
- **NIP-05 は検証していません。** kind 0 の `nip05` はパースしますが、`.well-known/nostr.json`
  との照合を行わないため、著者の自己申告にすぎません。誤解を招かないよう画面には表示していません
- **プロフィールはカードが画面に入ってから取得します**（`IntersectionObserver`）。
  1 著者につき `{"kinds":[0],"authors":["<pubkey>"]}` の購読を 1 本開き、EOSE から
  500ms 後に閉じます（リレーは取り込み完了を待たずに EOSE を返すため、即座に閉じると
  取得したてのプロフィールを取りこぼします）。同時に走るのは 4 本までで、残りは
  順番待ちです。応答が無いまま 5 秒経った購読は打ち切って枠を返します。
  カードの 200px 手前で取得を始めるので、通常は表示までに名前が揃います。
  `IntersectionObserver` が無い環境では、遅延せず即座に取得します。
  フォロータイムラインは著者が散るぶん重複が最も少ない条件ですが、実測では
  50 件で 13〜19 人程度（よく投稿する人が複数件を占めるため）。4 本並列で数波なので、
  全員の名前がそろうまで数秒かかることがあります（カードは順次埋まります）
- **上流へ問い合わせ直すかどうかはリレーが判断します**（`upstreamFreshness` の kind 0 の窓。
  既定 86400 秒 = 24 時間。属性・クエリパラメータの `profile-freshness`、または JS から
  `acquireRelayHost` を使う場合は `profileFreshness` で変更できます）。
  鮮度判定はフィルタ単位の all-or-nothing ですが、
  1 フィルタ 1 著者なので**著者ごとに独立して効きます** — プロフィール未公開の著者が
  混ざっていても、他の著者のキャッシュ済みプロフィールは上流に問い合わせずに返ります
- **同じ著者を二度は取得しません**（カードが画面外へ出て戻っても再要求しません）。
  したがって**画面を開いたまま kind 0 が更新されても反映されません**。リロードしても、
  鮮度ウィンドウ（既定 24 時間）の内側ならキャッシュがそのまま返るため、
  更新が反映されるのは窓が切れたあとの取得時です。早く反映したい場合は
  `profile-freshness` を短く（`0` なら毎回上流に問い合わせ）してください
- **1 ページにつきリレーは 1 つ**です。複数の `<nostr-timeline>` を置いた場合、リレーは
  共有されます（購読はウィジェットごとに独立するので表示内容は別々にできます）。
  設定は**最初に mount されたウィジェットのものが採用され**、異なる設定を要求した
  ウィジェットには警告が出ます。これは、1 ページから同じ上流リレーへ何本も接続を
  張らないための意図的な制約です。設定を分けたい場合は iframe を使ってください。
- **`globalThis.WebSocket` を差し替えます**（Web Component 方式のみ）。差し替え前に
  `const WS = WebSocket` のようにコンストラクタ参照を保持しているライブラリには
  キャッシュが効きません。最後のウィジェットが DOM から外れると元に戻します。
- **上流全滅中の投稿は失われます**（再送キューは未実装）。ウィジェット自体は
  読み取り専用なので直接は影響しません。
- **上流 AUTH（NIP-42）は未対応**です。認証が必要なリレーには接続できません。
- リレーコア由来の制約（NIP-40 の期限切れ未対応、削除済みイベントの「復活」を
  防げないなど）はそのまま効きます。

## バンドルサイズ

`dist/nostr-timeline.js` は約 **334 KB（gzip 約 111 KB）** の自己完結した IIFE です
（`<nostr-timeline>` と `<nostr-follow-timeline>` の両方を含みます）。
CSS も含めて 1 ファイルに収まっています（Shadow DOM 内へインライン展開されるため
別途スタイルシートを読み込む必要はありません）。大部分は Dexie（IndexedDB）、
署名検証用の `@rx-nostr/crypto`、そしてリレー接続管理の `rx-nostr`（+ RxJS）で、
いずれもリレー本体とクライアント接続の機能に必要です。

## ライブラリとしての利用

`packages/demo-site` のように、Svelte アプリからコンポーネントと計測ロジックを
直接使うこともできます（`exports` はソースを指しています）:

```ts
import {
  Timeline,
  TimelineController,
  acquireRelayHost,
  parseFilter,
  parseRelays,
} from '@nostr-cache/timeline-embed';
```

主なエクスポート:

| 名前 | 内容 |
|---|---|
| `acquireRelayHost` / `getRelayHostRefCount` | ページ共有リレーの取得（参照カウント付き） |
| `TimelineController` | リレー起動・購読・状態通知をまとめたフレームワーク非依存の駆動部 |
| `CacheMetrics` | イベント由来（cache / upstream）の分類とカウンタ |
| `InstrumentedUpstreamPool` | `UpstreamPool` デコレータ。cache-relay 無改変で上流トラフィックを計測 |
| `RequestTimer` | REQ → 初回イベント → EOSE の計測 |
| `RelayConnection` | rx-nostr を使った NIP-01 クライアント。切断時の自動再接続と REQ の再送を担う |
| `parseProfileContent` / `authorName` / `authorHandle` | kind 0 の防御的パースと表示名の決定 |
| `parseRefs` | `e` / `q` タグから返信・引用の参照を抽出（NIP-10 のマーカー付き / 位置指定の両方） |
| `parseContent` / `inlineParts` / `mediaParts` / `mediaAsLinks` | 本文を URL・添付・`nostr:` エンティティのトークン列へ分解する（マークアップは作らない） |
| `Timeline` / `EventCard` / `NoteContent` / `MediaAttachment` / `Avatar` | 表示コンポーネント |
| `parseFreshness` / `parseDebug` / `parseShowOriginAlias` | 属性・クエリパラメータの解釈（ウィジェットと同じ判定） |
| `parseFilters` / `parseFilter` / `parseFilterList` | 購読フィルタの組み立て。`parseFilters` が `filters` JSON とカンマ区切り属性の優先順位を裁く |
| `normalizeActions` / `dispatchActionEvent` / `ACTION_EVENT` / `MAX_ACTIONS` | 投稿下ボタンの定義解釈と押下通知（`EventAction` 型付き） |
| `parseMaterialVariant` / `ensureMaterialSymbols` / `materialFontFamily` / `materialFontHref` | Material Symbols の変種解釈と、document へのフォント登録 |
| `parseFollowList` / `selectAuthors` | kind 3 の `p` タグ解釈と `authors` の組み立て（純粋関数。DOM もリレーも要らない） |
| `followFilterSource` | フォローリストを引いてタイムラインフィルタを返す `FilterSource` |
| `fetchLatestReplaceable` | replaceable イベントを 1 件だけ引く one-shot REQ（EOSE グレース・`created_at` 最大採用・ウォッチドッグ込み） |

`Timeline` を直接使う場合、`showOrigin` の既定は **`true`**（バッジ表示）です。
既定で非表示なのは `<nostr-timeline>` 側の話で、コンポーネントを直接組み込む利用者は
表示可否を自分で決められる、という切り分けです（`packages/demo-site` はこれを利用して
常時バッジを出しています）。

## 開発

```bash
# 依存パッケージのビルドが前提
npm run build -w packages/shared -w packages/cache-relay

npm run build:embed    # dist/nostr-timeline.js + dist/embed/{,follow/}index.html
npm run test -w packages/timeline-embed
npm run typecheck -w packages/timeline-embed
```

## 実装メモ

- 相対 import は `.ts` 拡張子付きで記述します（`allowImportingTsExtensions` +
  Biome の `useImportExtensions` の両立のため）
- Svelte 5 の runes は `.svelte` ファイル内のみで使用し、`.ts` モジュールは
  フレームワーク非依存に保っています（単体テスト容易性のため）
- `customElement: true` は**カスタム要素サポートを有効にするだけ**で、実際に
  カスタム要素になるのは `<svelte:options customElement="..." />` を持つ
  `nostr-timeline.svelte` と `nostr-follow-timeline.svelte` のみです。
  他のコンポーネントは通常の Svelte コンポーネントとしてライブラリ利用できます
- 2 つのカスタム要素が重複して持つのは**props 宣言と `$host()` の受け取り 1 行だけ**です。Svelte のカスタム要素は
  `<svelte:options customElement>` で props を静的に宣言する必要があるためで、
  中身（エラー表示・再接続表示・`Timeline` の描画・スタイル）は
  `components/TimelineView.svelte` に切り出して共有しています。バンドルも 1 本のままです
- iframe ページも 2 枚（`public/embed/` と `public/embed/follow/`）ありますが、
  クエリパラメータの転送と高さの `postMessage` は `public/embed/embed-host.js` に
  1 つだけあります。各ページが持つのは「どの要素にどの属性を渡すか」の一覧だけで、
  その一覧が要素の宣言と食い違っていないことは `embed-page.spec.ts` が検査します
