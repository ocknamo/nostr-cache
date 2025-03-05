# Nostr Cache

Nostrリレーとのやり取りをキャッシュするためのモノリポプロジェクト。

## プロジェクト構成

このプロジェクトは以下のパッケージで構成されています：

- **cache-lib**: Nostrリレーとのやり取りをキャッシュするライブラリ
- **shared**: 共有型定義とユーティリティ
- **web-client**: Angularベースのフロントエンドクライアント
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

# キャッシュライブラリのビルド
npm run build:cache-lib
```

## テスト

```bash
# すべてのパッケージのテストを実行
npm run test
```

## ライセンス

[MIT](LICENSE)
