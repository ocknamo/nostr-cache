# Nostr Cache

Nostrリレーとのやり取りをキャッシュするためのモノリポプロジェクト。

## プロジェクト構成

このプロジェクトは以下のパッケージで構成されています：

- **cache-relay**: Nostrリレーとのやり取りをキャッシュするためのリレーパッケージ
- **shared**: 共有型定義とユーティリティ
- **types**: Nostrキャッシュプロジェクト全体で使用される型定義
- **web-client**: Angularベースのフロントエンドクライアント（Angular 19.2.0）
- **server**: 将来的なサーバーサイド実装（計画段階）

## 開発環境のセットアップ

```bash
# 依存関係のインストール
npm install

# すべてのパッケージをビルド
npm run build
```

## 開発

```bash
# Webクライアントの開発サーバーを起動
npm run dev:web-client

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

## ライセンス

[MIT](LICENSE)
