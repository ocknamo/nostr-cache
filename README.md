# Nostr Cache

**注意: このリポジトリは開発中のため、一部の機能は正常に動作しません。**

Nostrリレーとのやり取りをキャッシュするためのモノリポプロジェクト。

## プロジェクト構成

このプロジェクトは以下のパッケージで構成されています：

- **cache-relay**: Nostrリレーとのやり取りをキャッシュするためのリレーパッケージ（一部未実装）
- **shared**: 共有型定義とユーティリティ
- **types**: Nostrキャッシュプロジェクト全体で使用される型定義
- **web-client**: Angularベースのフロントエンドクライアント（開発中）
- **server**: サーバーサイドリレー実装（開発中）

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
