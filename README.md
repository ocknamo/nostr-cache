# Nostr Cache

**注意: このリポジトリは実験的な開発段階のプロジェクトです。**

Nostrリレーとのやり取りをキャッシュするためのモノリポプロジェクト。

**▶ 公開デモ: <https://ocknamo.github.io/nostr-cache/>**
（透過キャッシュの動作・キャッシュ由来の可視化・コールド/ウォーム計測・埋め込みウィジェット）

## 目的 / ビジョン

Nostrクライアントのキャッシュを**完全に**行うため、キャッシュ専用の仕組みを作り込むのではなく、**クライアント層で動くNostrリレー実装そのもの**を用意し、それをキャッシュとして動かす、というアイデアから始まっている。

- **サーバで実行すれば普通のリレー**として動く。
- **Webクライアントでは、ページ内のWebSocketをインターセプト**（あるいは同等の手段）してローカルリレーとして動かし、クライアントの通信を肩代わりする。
- 最終的には、ローカルリレーが**上流の実リレー群の手前に透過的に挟まり**、リードスルー / ライトスルーで「完全なキャッシュ」として機能することを目指す。

同一のリレーコア（`cache-relay`）のトランスポートとストレージを差し替えることで、この2形態を実現する。背景・全体像・現状とのギャップは [doc/concept.md](./doc/concept.md) を参照。

## プロジェクト構成

このプロジェクトは以下のパッケージで構成されています：

- **cache-relay**: クライアント層で動くNostrリレー実装本体。キャッシュの中核
- **shared**: 共有型定義とユーティリティ
- **server**: サーバーサイドリレー実装（開発中）
- **web-client**: Svelte 製 Web クライアント。ブラウザ内ローカルリレーへの E2E 配線デモ
  （タイムライン + フィルタフォーム。`npm run dev:web` で起動）
- **timeline-embed**: 他サイトに埋め込めるタイムラインウィジェット
  （iframe / Web Component の 2 形態。`npm run build:embed`）
- **demo-site**: GitHub Pages で公開する透過キャッシュのデモサイト
  （`npm run dev:demo`）

## 現状（2026-07）

リレーコア（イベント種別処理・検証・NIP-01/02・ストレージ・購読管理）は実装済みで、
モノレポ全体のビルド・型チェック・テストは CI で緑になっています。
「Web クライアント → ローカルリレー（キャッシュ）」のエンドツーエンド配線は
Svelte 製 web-client（`WebSocketServerEmulator` + IndexedDB で動くブラウザ内リレーに接続）
として実装済みです。上流リレーへの透過キャッシュ化（リードスルー / ライトスルー）も
オプトインで実装済みです。server の実永続化も、環境変数 `NOSTR_DB_PATH`（または
`storageOptions.dbPath`）指定による `node:sqlite` バックエンドとしてオプトインで
実装済みです（既定は従来どおり `fake-indexeddb`（インメモリ）で、再起動で消えます）。
透過キャッシュを実際に体験できる公開デモ（GitHub Pages）と、他サイトへ埋め込める
タイムラインウィジェット（iframe / Web Component）も実装済みです。
残作業の詳細は [doc/TODO.md](./doc/TODO.md) を参照してください。
主な未実装・既知の制約は次のとおりです：

- **対応 NIP は NIP-01 と NIP-02**（kind 3 を replaceable として扱う範囲）のみ。特に
  **NIP-09（イベント削除・kind 5）は未対応**で、削除イベントを受け取っても対象イベントは
  ストレージに残り続けます（上流で削除されたイベントをキャッシュが配信し続けます）。
  NIP-40（`expiration` タグ）・NIP-11（リレー情報ドキュメント）・NIP-42（AUTH）も未対応
- **時間窓ベースのレート制限**（メッセージ / EVENT 投稿の頻度制限）は未実装

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

- [packages/timeline-embed/README.md](./packages/timeline-embed/README.md): 埋め込みウィジェットの使い方（iframe / Web Component）
- [doc/transparent-cache.md](./doc/transparent-cache.md): 透過型キャッシュをクライアントに埋め込む手順
- [doc/api.md](./doc/api.md): 主要パッケージ（shared / cache-relay / server）の API リファレンス
- [examples/](./examples/README.md): 実行可能なサンプル（`@nostr-cache/cache-relay` を使った Node.js E2E デモ）
- [doc/concept.md](./doc/concept.md): 背景・全体像
- [doc/TODO.md](./doc/TODO.md): 残作業一覧

## ライセンス

[MIT](LICENSE)
