# @nostr-cache/demo-site

GitHub Pages で公開する透過キャッシュのデモサイト。

公開先: <https://ocknamo.github.io/nostr-cache/>

## 内容

1. **ライブタイムライン** — 上流リレー・kinds・limit・`profile-freshness` を設定して購読し、
   各イベントに `cache` / `upstream` バッジを表示（`debug` チェックボックスで即時に
   切り替わり、外すと実際の埋め込みと同じ見え方になります）。キャッシュ配信数 /
   上流取得数 / 上流接続数 / キャッシュ保存数のライブカウンタつき
2. **コールド / ウォーム計測** — キャッシュを空にした 1 回目と、同じ REQ をもう一度
   投げた 2 回目を比較。初回イベントまでの時間で効果を示す
3. **埋め込み** — `<iframe>` と `<nostr-timeline>` の実物を並べ、コピペ用スニペットを表示。
   デモサイト自身が `@nostr-cache/timeline-embed` の利用者になっている

## 開発

埋め込みバンドルを先にビルドしてください。デモ内の iframe と `<script src>` は
`packages/timeline-embed/dist` を参照します（dev サーバーでは Vite ミドルウェアが
そこから配信します）。

```bash
npm run build -w packages/shared -w packages/cache-relay   # 依存パッケージ
npm run build:embed                                        # 埋め込みバンドル
npm run dev:demo                                           # http://localhost:5174/nostr-cache/
```

## ビルド

```bash
npm run build:demo
```

`vite build` の後に `scripts/copy-embed.mjs` が走り、`packages/timeline-embed/dist`
（`nostr-timeline.js` と `embed/index.html`）を `dist/` へ取り込みます。GitHub Pages は
1 ディレクトリしか配信しないため、SPA と埋め込み資産を同一オリジンにまとめる必要が
あります。これにより、公開されるスニペットの `<script src>` / `<iframe src>` が
そのまま動きます。

`base` は `/nostr-cache/`（プロジェクトページのサブパス）です。

## デプロイ

`.github/workflows/pages.yml` が `main` への push で自動デプロイします。

**リポジトリ側の初回設定が必要です**: Settings → Pages → Source を
「GitHub Actions」に変更してください（ワークフローだけでは有効化できません）。

## 注意

- 上流リレーは `wss://` のみ指定できます。Pages は https で配信されるため、
  `ws://` は混在コンテンツとしてブラウザに遮断されます
- キャッシュは訪問者のブラウザの IndexedDB（データベース名 `nostr-cache-demo`）に
  保存されます。「キャッシュを消して計測する」で全消去されます
