# @nostr-cache/timeline-embed

他サイトに埋め込める Nostr タイムラインウィジェット。ブラウザ内で動く
`@nostr-cache/cache-relay` を上流リレーの手前に**透過キャッシュ**として挟み、
イベントを IndexedDB に貯めながら表示します。

- 初回は上流リレーから取得、2 回目以降はローカルキャッシュから即座に表示
- 各イベントに `cache` / `upstream` バッジを表示（キャッシュが効いているのが目で見える）
- 署名検証はリレーがバックグラウンドで実行し、検証済みイベントに ✓ を表示
  （クライアント側で暗号処理をしない）

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

高さを内容に合わせたい場合は、埋め込みページが送る `postMessage` を拾ってください:

```js
window.addEventListener('message', (event) => {
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
}
```

## 制約

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

`dist/nostr-timeline.js` は約 **232 KB（gzip 約 78 KB）** の自己完結した IIFE です。
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
| `Timeline` / `EventCard` | 表示コンポーネント |

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
