# @nostr-cache/web-client

Svelte 5 + Vite 製の Web クライアント。ブラウザ内で動くローカルキャッシュリレー
（`@nostr-cache/cache-relay` の `WebSocketServerEmulator` + `DexieStorage`）への
エンドツーエンド配線のデモを兼ねています。

## 機能

- **タイムライン**: 購読したイベントを `created_at` 降順で表示（ライブ更新対応）
- **フィルタフォーム**: NIP-01 フィルタ（kinds / authors / ids / limit / since / until）を
  フォームまたは生 JSON で入力して購読を張り替え
- **投稿フォーム**: kind 1 テキストノートを署名して投稿（鍵はセッション毎にランダム生成）
- **リレー接続バー**: 接続先 URL の変更・接続/切断

## アーキテクチャ

起動時にブラウザ内でローカルリレーを組み立てます:

```
DexieStorage (IndexedDB)
  + WebSocketServerEmulator (ws://localhost:3000 を横取り)
  + NostrCacheRelay
```

クライアント側 (`RelayConnection`) は素の `new WebSocket(url)` を使うだけです。
既定の `ws://localhost:3000` への接続はエミュレータが横取りし、**ネットワークに
一切出ずに**ブラウザ内リレーへ NIP-01 で届きます。投稿はブラウザの IndexedDB に
永続化されるため、リロード後も再購読で再生されます。

URL を `wss://nos.lol` など実リレーに変更すると、そのまま実リレーへ直結できます
（同一 UI で両対応）。

## 開発

```bash
# 依存パッケージのビルドが前提
npm run build -w packages/shared -w packages/cache-relay

# 開発サーバー (http://localhost:5173)
npm run dev:web        # リポジトリルートから
```

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | Vite 開発サーバー |
| `npm run build` | プロダクションビルド (`dist/`) |
| `npm run typecheck` | `svelte-check`（.ts / .svelte の型チェック） |
| `npm run test` | Vitest（lib モジュールの単体テスト） |
| `npm run lint:check` / `format:check` | Biome（`.svelte` は対象外・ルート設定で除外） |

## 実装メモ

- 相対 import は `.ts` 拡張子付きで記述します（`allowImportingTsExtensions` +
  Biome の `useImportExtensions` の両立のため）
- Svelte 5 の runes（`$state` / `$props`）は `.svelte` ファイル内のみで使用し、
  `.ts` モジュールはフレームワーク非依存に保っています（Biome の対象化と単体テスト容易性のため）
- `@nostr-cache/cache-relay` はブラウザでは `@nostr-cache/cache-relay/browser`
  エントリポイントから import します（Node.js 専用の `WebSocketServer` を含まないため
  バンドル可能）
