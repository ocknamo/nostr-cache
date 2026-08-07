# @nostr-cache/timeline-embed

他サイトに埋め込める Nostr タイムラインウィジェット。ブラウザ内で動く
`@nostr-cache/cache-relay` を上流リレーの手前に**透過キャッシュ**として挟み、
イベントを IndexedDB に貯めながら表示します。

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

## 属性 / クエリパラメータ

| 名前 | 内容 | 既定値 |
|---|---|---|
| `relays` | 上流リレー URL（カンマ区切り）。空ならキャッシュ済みイベントのみ表示 | なし |
| `filters` | NIP-01 フィルタ配列の JSON。指定すると `kinds` / `authors` / `limit` は無視される（[下記](#filters-で細かく絞り込む)） | なし |
| `kinds` | イベント種別（カンマ区切り） | `1` |
| `authors` | 著者 pubkey（hex・カンマ区切り） | 指定なし |
| `limit` | 取得件数 | `50` |
| `db-name` | IndexedDB のデータベース名 | `nostr-cache-embed` |
| `profile-freshness` | プロフィール（kind 0）のキャッシュを上流に問い合わせ直さずに使う秒数。`0` で毎回問い合わせる | `86400`（24 時間） |
| `debug` | 動作確認用。付けると各投稿に `cache` / `upstream` バッジを表示する | なし（非表示） |
| `show-origin` | **非推奨**。`debug` の旧称。`true` なら `debug` と同じくバッジを表示する（`false` は既定と同じ） | なし（非表示） |
| `show-avatars` | `false` でアバター画像を隠す（表示名は取得したまま） | `true` |
| `show-media` | `false` で本文中の画像・動画・音声の埋め込みを止める（URL はリンクとして残る） | `true` |

`profile-freshness` は iframe（`&profile-freshness=3600`）と Web Component
（`profile-freshness="3600"`）のどちらでも同じように指定できます。プロフィールの更新を
早く反映したい場合は短く、上流への問い合わせをさらに減らしたい場合は長くしてください。
**1 ページにリレーは 1 つ**なので、複数の `<nostr-timeline>` を置く場合はこの値も
揃えてください（揃っていないと最初のウィジェットの値が採用され、警告が出ます）。

`debug` は値なしの `debug`（iframe なら `&debug`）でも `debug="true"` でも有効になります。
`cache` / `upstream` バッジは**キャッシュが効いていることを埋め込む側が確認するための表示**なので、
既定では出しません。実際のサイトに埋め込むときは付けないでください。

旧称の `show-origin` も引き続き動きます（コンソールに非推奨の警告を 1 回出します）。
`show-origin="true"` は `debug` と同じくバッジを表示します。ただし**属性を書かない場合は
表示しません** — 以前は既定で表示されていましたが、そこが今回変わった点です。

不正な値（WebSocket でない URL、整数でない kind、負の `profile-freshness` など）は
警告を出して無視されます（既定値のまま動作します）。
**https のページからは `ws://` の上流リレーを指定できません**（ブラウザが混在コンテンツ
として遮断するため）。`wss://` を使ってください。

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
- リレーが解釈できないフィルタは REQ ごと拒否されてしまうため、`search` のような
  未対応のキーや型の合わない値は、警告を出してこちら側で落とします。
  絞り込み条件（`authors` など）の値が全滅したフィルタは、条件が消えて検索範囲が
  広がってしまわないよう、そのフィルタごと捨てます。
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
  --nt-avatar-size: 40px;
  --nt-avatar-radius: 8px;
  --nt-avatar-gap: 10px;        /* アバターと本文の間隔 */
  --nt-name-fg: #e6edf3;        /* 表示名 */
  --nt-handle-fg: #8b949e;      /* @handle。既定は --nt-muted */
  --nt-quote-bar: #4a7dff;      /* 返信 / 引用チップの縦線 */
  --nt-tip-bg: #0f1419;         /* 日付ツールチップの背景 */
  --nt-tip-fg: #ffffff;         /* 日付ツールチップの文字色 */
  --nt-tip-clearance: 48px;     /* 先頭カードの日付ツールチップ用に確保する上部余白 */

  /* 本文（リンク・メンション・添付） */
  --nt-link-fg: #58a6ff;        /* 本文中のリンク */
  --nt-mention-fg: #58a6ff;     /* nostr: メンション */
  --nt-mention-bg: transparent;
  --nt-media-max-height: 400px; /* 添付画像・動画の高さの上限 */
  --nt-media-radius: 10px;
  --nt-media-bg: #161b22;       /* 読み込み中の添付の背景 */
}
```

日時は年月日を省いた `12:33:45` 形式です（名前から時刻までを必ず一行に収めるため）。
省いた日付は時刻をホバー、またはタップすると**ツールチップ**で表示されます
（キーボードでも開けます。Esc で閉じます）。`<time datetime>` には ISO 8601 の
完全な日時が入っているので、機械可読な値はそのまま取得できます。ツールチップは
時刻の上に開くため、リスト先頭には常に `--nt-tip-clearance` 分の余白があります。

カードは既定で**区切り線で連なるリスト**です（一般的な Nostr クライアントの見え方）。
`--nt-gap` を指定すると、従来どおり間隔の空いたブロックとして並びます。

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

## 制約

- **署名未検証のイベントも表示されます。** ウィジェットはリレーを遅延検証
  （`validateEventsType: 'LAZY'`）で起動します。イベントは受信時点では検証されずに
  保存・表示され、バックグラウンド検証（既定 5 秒間隔）が署名不正と判断したものを
  あとから削除します。したがって **✓ が付いていないイベントは「検証待ち」か
  「検証に失敗して削除される直前」のどちらか**で、その間は画面に残ります。
  表示内容の真正性が重要な用途では、✓ が付いたイベントだけを信頼してください
  （この方式は、クライアント側で暗号処理をせずに済ませるための意図的なトレードオフです）
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
  `IntersectionObserver` が無い環境では、遅延せず即座に取得します
- **上流へ問い合わせ直すかどうかはリレーが判断します**（`upstreamFreshness` の kind 0 の窓。
  既定 86400 秒 = 24 時間。属性・クエリパラメータの `profile-freshness`、または JS から
  `acquireRelayHost` を使う場合は `profileFreshness` で変更できます）。
  鮮度判定はフィルタ単位の all-or-nothing ですが、
  1 フィルタ 1 著者なので**著者ごとに独立して効きます** — プロフィール未公開の著者が
  混ざっていても、他の著者のキャッシュ済みプロフィールは上流に問い合わせずに返ります
- **リレーコアの replaceable 置換バグの影響を、既定 24 時間ぶん受けます。** cache-relay は
  replaceable イベントの置換時に `created_at` を比較していないため（`doc/TODO.md` の
  「優先度: 高」項目）、**古い署名済み kind 0 を1通投げるだけで新しい版を上書きでき**、
  その保存で `cached_at` が現在時刻になります。鮮度ウィンドウが有効だと、その stale な版が
  **窓の秒数ぶん固定されます**（窓が無効なら次の取得で上流に問い合わせて自己修復します）。
  既定を 300 秒から 24 時間へ延ばしたことで、この固定時間も同じだけ延びています。
  kind 0 の `picture` は実際に画像として読みに行く URL なので、気になる場合は
  `profile-freshness` を短くするか `0`（毎回上流へ問い合わせ）にしてください
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
- リレーコア由来の制約（NIP-09 削除・NIP-40 期限切れの未対応など）はそのまま効きます。
  上流で削除されたイベントをキャッシュが配信し続ける可能性があります。

## バンドルサイズ

`dist/nostr-timeline.js` は約 **325 KB（gzip 約 108 KB）** の自己完結した IIFE です。
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

`Timeline` を直接使う場合、`showOrigin` の既定は **`true`**（バッジ表示）です。
既定で非表示なのは `<nostr-timeline>` 側の話で、コンポーネントを直接組み込む利用者は
表示可否を自分で決められる、という切り分けです（`packages/demo-site` はこれを利用して
常時バッジを出しています）。

## 開発

```bash
# 依存パッケージのビルドが前提
npm run build -w packages/shared -w packages/cache-relay

npm run build:embed    # dist/nostr-timeline.js + dist/embed/index.html
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
  `nostr-timeline.svelte` のみです。他のコンポーネントは通常の Svelte
  コンポーネントとしてライブラリ利用できます
