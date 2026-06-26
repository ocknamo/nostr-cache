# サンプルコード / Examples

`nostr-cache` の公開 API を使った実行可能なサンプルです。

Runnable samples that use the public API of `nostr-cache`.

## `node-relay-demo.mjs`

`@nostr-cache/cache-relay` だけでインプロセスのリレーを起動し、`ws` クライアントから
NIP-01 の一連の流れ（`EVENT` → `OK`、`REQ` → `EVENT`/`EOSE`、`CLOSE` → `CLOSED`）を
実演します。ストレージは `fake-indexeddb` を使ったインメモリ IndexedDB です。

Boots an in-process relay using only `@nostr-cache/cache-relay`, then drives a
full NIP-01 round trip from a `ws` client (`EVENT` → `OK`, `REQ` →
`EVENT`/`EOSE`, `CLOSE` → `CLOSED`). Storage is an in-memory IndexedDB backed by
`fake-indexeddb`.

### 実行 / Run

リポジトリルートで依存関係をインストール済みであることが前提です。
まず `cache-relay` をビルドしてから実行します。

From the repository root (dependencies installed), build `cache-relay` first,
then run the demo:

```bash
npm install            # 未実行の場合 / if not done yet
npm run build          # shared / cache-relay などを先にビルド / build the workspaces first
node examples/node-relay-demo.mjs
```

> `node-relay-demo.mjs` は `@nostr-cache/cache-relay` と `@nostr-cache/shared` の
> ビルド済み成果物（`dist/`）を import します。`cache-relay` は実行時に `shared` を
> 参照するため、`npm run build`（全ワークスペース）でまとめてビルドするのが確実です。

### 期待される出力 / Expected output

```text
[relay] listening on ws://localhost:4848
[client] connected
[client] OK received: accepted=true id=…
[client] received event via REQ: "Hello from the nostr-cache demo!"
[client] EOSE received
[client] subscription closed
[relay] stopped — demo complete ✔
```

> ロガーの `[INFO] …` 行も併せて表示されます（リレー内部のログ）。
> The relay also prints its internal `[INFO] …` log lines.

### 使用している API / APIs used

- `NostrCacheRelay`, `DexieStorage`, `WebSocketServer`（`@nostr-cache/cache-relay`）
- `getRandomSecret`（`@nostr-cache/shared`）— 秘密鍵生成 / secret key generation
- `seckeySigner`（`rx-nostr-crypto`）— イベント署名 / event signing
- `ws` — WebSocket クライアント / WebSocket client

API の詳細は [`doc/api.md`](../doc/api.md) を参照してください。
See [`doc/api.md`](../doc/api.md) for the full API reference.
