# Nostr Cache

**注意: このリポジトリは実験的な開発段階のプロジェクトです。**

Nostrリレーとのやり取りをキャッシュするためのモノリポプロジェクト。

**▶ 公開デモ: <https://ocknamo.github.io/nostr-cache/>**
（透過キャッシュの動作・キャッシュ由来の可視化・コールド/ウォーム計測・埋め込みウィジェット）

## 目的 / ビジョン

キャッシュ専用の仕組みを作り込むのではなく、**クライアント層で動くNostrリレー実装そのもの**を
用意し、それをキャッシュとして動かす。同一のリレーコア（`cache-relay`）のトランスポートと
ストレージを差し替えることで、サーバでは普通のリレーとして、Webクライアントでは
ページ内のWebSocketを横取りするローカルリレーとして動作する。

背景・全体像・設計の根拠は [doc/concept.md](./doc/concept.md) を参照。

## プロジェクト構成

| パッケージ | 役割 |
|---|---|
| [cache-relay](./packages/cache-relay/README.md) | クライアント層で動くNostrリレー実装本体。キャッシュの中核 |
| [shared](./packages/shared/README.md) | 共有型定義とユーティリティ |
| [server](./packages/server/README.md) | Node.js リレーサーバー（`npm run dev:server`） |
| [web-client](./packages/web-client/README.md) | Svelte 製の開発用クライアント。ブラウザ内ローカルリレーへの E2E 配線デモ（`npm run dev:web`） |
| [timeline-embed](./packages/timeline-embed/README.md) | 他サイトに埋め込めるタイムラインウィジェット（iframe / Web Component。`npm run build:embed`） |
| [demo-site](./packages/demo-site/README.md) | GitHub Pages で公開する透過キャッシュのデモサイト（`npm run dev:demo`） |

実装状況（対応 NIP・実装済みの機能・既知の制約・残作業）は [doc/TODO.md](./doc/TODO.md) に
まとめてあります。

## 開発環境のセットアップ

```bash
# 依存関係のインストール
npm install

# すべてのパッケージをビルド
npm run build
```

## 開発

```bash
# キャッシュリレーパッケージのビルド
npm run build:cache-relay

# サーバーパッケージのビルド
npm run build:server

# サーバーの開発モードで起動（ホットリロード対応）
npm run dev:server

# サーバーを本番モードで起動
npm run start:server
```

## テスト

```bash
# すべてのパッケージのテストを実行
npm run test
```

## ドキュメント

各トピックの記述は 1 か所にだけ置き、他からはリンクします。

| 知りたいこと | 参照先 |
|---|---|
| 何を実現しようとしているか | [doc/concept.md](./doc/concept.md) |
| 実装状況・既知の制約・残作業 | [doc/TODO.md](./doc/TODO.md) |
| 公開 API（型・オプション・NIP の適用ルール） | [doc/api.md](./doc/api.md) |
| 既存クライアントに透過キャッシュを挟む手順 | [doc/transparent-cache.md](./doc/transparent-cache.md) |
| 埋め込みウィジェットの使い方 | [packages/timeline-embed/README.md](./packages/timeline-embed/README.md) |
| リレーコアの内部設計 | [doc/cache-relay/](./doc/cache-relay/) |
| 実行可能なサンプル | [examples/](./examples/README.md) |

## ライセンス

[MIT](LICENSE)
