# @nostr-cache/web-client

Svelte 5 + Vite 製の開発用クライアント。ブラウザ内で動くローカルキャッシュリレーへの
エンドツーエンド配線を最小構成で示すもので、プロダクト志向の UI ではありません。
埋め込み用の完成形は [timeline-embed](../timeline-embed/README.md)、公開デモは
[demo-site](../demo-site/README.md) を参照してください。

## 機能

- **タイムライン**: 購読したイベントを `created_at` 降順で表示（ライブ更新対応）
- **フィルタフォーム**: NIP-01 フィルタ（kinds / authors / ids / limit / since / until）を
  フォームまたは生 JSON で入力して購読を張り替え
- **投稿フォーム**: kind 1 テキストノートを署名して投稿（鍵はセッション毎にランダム生成）
- **リレー接続バー**: 接続先 URL の変更・接続/切断

## アーキテクチャ

起動時に `startLocalRelay()`（`src/lib/local-relay.ts`）がブラウザ内でローカルリレーを
組み立て、クライアントは rx-nostr 経由で `ws://nostr-cache.invalid` へ接続します。

```
DexieStorage (IndexedDB)
  + WebSocketServerEmulator (ws://nostr-cache.invalid を横取り)
  + NostrCacheRelay
```

```
App.svelte
├── ConnectionBar     接続状態と接続先 URL
├── FilterForm        NIP-01 フィルタの入力（src/lib/filter-form.ts が解析）
├── PostForm          kind 1 の投稿（src/lib/event-signer.ts が署名）
└── Timeline → EventCard
```

エミュレータが横取りするため、この URL への通信は**ネットワークに一切出ません**。
接続が切れた場合の再接続と REQ の張り直しは rx-nostr に任せています（接続状態バーは
再接続中を `再接続中…` と表示）。仕組みの詳細は
[doc/transparent-cache.md](../../doc/transparent-cache.md) を参照してください。

タイムライン表示・購読・検証バッジのロジックは web-client 固有ではなく、
`@nostr-cache/timeline-embed/lib`（`RelayConnection` / `insertEvent` /
`fetchValidationStatuses`）を timeline-embed と共有しています。

`App.svelte` の `UPSTREAM_RELAYS` に `wss://…` を入れると、ローカルリレーが上流の手前に
挟まる透過キャッシュになります。空のままなら、ローカルに持っているイベントだけを返す
独立キャッシュとして動きます。投稿は IndexedDB に永続化されるため、リロード後も再購読で
再生されます（= ローカルキャッシュとして機能していることが確認できます）。

`relayUrl` を `wss://nos.lol` など実リレーに変更すると、同じ UI でそのまま実リレーへ
直結できます。ただしこの経路ではエミュレータもキャッシュリレーも挟まらないため、
**署名を検証する主体が誰もいません**（後述のとおり rx-nostr 側の検証を切っているため）。
デモ・動作確認用と割り切ってください。

## 署名検証バッジ

ローカルリレーを `validateEventsType: 'LAZY'` で起動し、署名検証はリレーの
バックグラウンド検証に任せています。クライアントは自前で検証（重い処理）を行わず、
リレーが永続化した検証結果を `relay.getValidationStatus(ids)`（エミュレータ WebSocket を
介さない直接メソッド API）で一括取得し、検証済みイベントに ✓ バッジを表示します
（rx-nostr 側の検証は `skipVerify` で切っています）。

- イベント受信 / EOSE 後にデバウンス（200ms）してまとめて取得
- `pending` が残っている間だけ 5 秒間隔で再取得。`unknown` は削除・退避済みの
  確定状態なのでポーリングを駆動しない（全件確定で停止）
- 検証結果は IndexedDB に永続化されるため、リロード後の再検証は不要

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
