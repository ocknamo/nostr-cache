# @nostr-cache/timeline-embed

他サイトに埋め込める Nostr タイムラインウィジェット。ブラウザ内で動く
`@nostr-cache/cache-relay` を上流リレーの手前に**透過キャッシュ**として挟み、
イベントを IndexedDB に貯めながら表示します。

- 初回は上流リレーから取得、2 回目以降はローカルキャッシュから即座に表示
- 各イベントに `cache` / `upstream` バッジを表示（キャッシュが効いているのが目で見える）
- 署名検証はリレーがバックグラウンドで実行し、検証済みイベントに ✓ を表示
  （クライアント側で暗号処理をしない）
- アバター・表示名・`@handle` を kind 0（プロフィール）から表示。kind 0 は replaceable として
  同じキャッシュに載り、`upstreamFreshness` の鮮度ウィンドウ（既定 300 秒）が効くため、
  リロード後は上流に問い合わせず即座に出ます
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
| `kinds` | イベント種別（カンマ区切り） | `1` |
| `authors` | 著者 pubkey（hex・カンマ区切り） | 指定なし |
| `limit` | 取得件数 | `50` |
| `db-name` | IndexedDB のデータベース名 | `nostr-cache-embed` |
| `show-origin` | `false` で `cache` / `upstream` バッジを隠す | `true` |
| `show-avatars` | `false` でアバター画像を隠す（表示名は取得したまま） | `true` |

不正な値（WebSocket でない URL、整数でない kind など）は警告を出して無視されます。
**https のページからは `ws://` の上流リレーを指定できません**（ブラウザが混在コンテンツ
として遮断するため）。`wss://` を使ってください。

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
}
```

カードは既定で**区切り線で連なるリスト**です（一般的な Nostr クライアントの見え方）。
`--nt-gap` を指定すると、従来どおり間隔の空いたブロックとして並びます。

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
- **NIP-05 は検証していません。** kind 0 の `nip05` はパースしますが、`.well-known/nostr.json`
  との照合を行わないため、著者の自己申告にすぎません。誤解を招かないよう画面には表示していません
- **プロフィールは購読を 1 本増やします**。表示中の著者をまとめた
  `{"kinds":[0],"authors":[...]}` を 200ms のデバウンスで張り直します。取得済みの著者も
  含めて素直に問い合わせ直し、**上流への転送を省くかどうかはリレーが判断します**
  （`upstreamFreshness` の kind 0 の窓。既定 300 秒）。「キャッシュがまだ新鮮か」は
  キャッシュ自身の責務なので、ウィジェット側で二重に持たない方針です
- **鮮度ウィンドウはフィルタ単位で all-or-nothing** です。フィルタに挙げた著者のうち
  1 人でも kind 0 がキャッシュに無ければ（プロフィール未公開の著者を含む）、そのフィルタは
  従来どおり上流へ転送されます。プロフィールを持たない著者が混ざるタイムラインでは、
  著者が増えるたびに上流への問い合わせが発生します
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

`dist/nostr-timeline.js` は約 **244 KB（gzip 約 83 KB）** の自己完結した IIFE です。
CSS も含めて 1 ファイルに収まっています（Shadow DOM 内へインライン展開されるため
別途スタイルシートを読み込む必要はありません）。大部分は Dexie（IndexedDB）と
署名検証用の `rx-nostr-crypto` で、これらはリレー本体の機能に必要です。

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
| `RelayConnection` | 素の WebSocket 上の最小 NIP-01 クライアント |
| `parseProfileContent` / `authorName` / `authorHandle` | kind 0 の防御的パースと表示名の決定 |
| `parseRefs` | `e` / `q` タグから返信・引用の参照を抽出（NIP-10 のマーカー付き / 位置指定の両方） |
| `Timeline` / `EventCard` / `Avatar` | 表示コンポーネント |

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
