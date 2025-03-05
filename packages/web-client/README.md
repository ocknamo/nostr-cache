# Nostr Cache Web Client

Nostrキャッシュライブラリを使用したAngularベースのWebクライアント。

## 機能

- Nostrリレーとの通信
- キャッシュを活用した高速なデータ取得
- ユーザーフレンドリーなインターフェース

## 開発

```bash
# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run start
```

## ビルド

```bash
npm run build
```

## テスト

```bash
npm run test
```

## プロジェクト構造

```
src/
├── app/                  # アプリケーションコード
│   ├── components/       # UIコンポーネント
│   ├── services/         # サービス
│   ├── models/           # モデル
│   └── pages/            # ページコンポーネント
├── assets/               # 静的アセット
│   ├── images/           # 画像
│   └── styles/           # グローバルスタイル
└── environments/         # 環境設定
```

## 依存関係

- Angular 16
- RxJS
- @nostr-cache/cache-lib
- @nostr-cache/shared
