# web-client

`packages/web-client` は、ブラウザ内ローカルリレーへの配線を最小構成で示す
Svelte 5 + Vite の開発用クライアントである。`npm run dev:web` で起動する。

役割は「クライアント層で動くリレーがキャッシュとして機能する」ことの実証で、
プロダクト志向の UI ではない。埋め込み用の完成形は
[packages/timeline-embed](../packages/timeline-embed/README.md)、
公開デモは [packages/demo-site](https://ocknamo.github.io/nostr-cache/) を参照。

## 構成

起動時に `startLocalRelay()`（`src/lib/local-relay.ts`）が
`DexieStorage`（IndexedDB）+ `WebSocketServerEmulator` + `NostrCacheRelay` を組み立て、
クライアントは素の `new WebSocket('ws://nostr-cache.invalid')` で接続する
（エミュレータが横取りするため、この URL への通信はネットワークに出ない）。
仕組みの詳細は [transparent-cache.md](./transparent-cache.md) を参照。

```
App.svelte
├── ConnectionBar     接続状態と接続先 URL
├── FilterForm        NIP-01 フィルタの入力（src/lib/filter-form.ts が解析）
├── PostForm          kind 1 の投稿（src/lib/event-signer.ts が署名）
└── Timeline → EventCard
```

タイムライン表示・購読・検証バッジのロジックは web-client 固有ではなく、
`@nostr-cache/timeline-embed/lib`（`RelayConnection` / `insertEvent` /
`fetchValidationStatuses`）を timeline-embed と共有している。

`App.svelte` の `UPSTREAM_RELAYS` に `wss://…` を入れると、ローカルリレーが
上流の手前に挟まる透過キャッシュ（リードスルー / ライトスルー）になる。
空のままなら、ローカルに持っているイベントだけを返す独立キャッシュとして動く。
`relayUrl` を実リレーに差し替えれば、同じ UI で上流へ直結もできる。

投稿は IndexedDB に永続化されるため、リロード後も再購読で再生される
（= ローカルキャッシュとして機能していることが確認できる）。

## 署名検証バッジ

ローカルリレーを `validateEventsType: 'LAZY'` で起動し、署名検証は
リレーのバックグラウンド検証に任せている。クライアントは自前で検証（重い処理）を
行わず、リレーが永続化した検証結果を `relay.getValidationStatus(ids)`
（エミュレータ WebSocket を介さない直接メソッド API）で一括取得し、
検証済みイベントに ✓ バッジを表示する。

- イベント受信 / EOSE 後にデバウンス（200ms）してまとめて取得
- `pending` が残っている間だけ 5 秒間隔で再取得。`unknown` は削除・退避済みの
  確定状態なのでポーリングを駆動しない（全件確定で停止）
- 検証結果は IndexedDB に永続化されるため、リロード後の再検証は不要

## 関連ドキュメント

- [NIP-01](./nips/nip-01.md): 購読・イベントのプロトコル
- [api.md](./api.md): `startLocalRelay` が組み立てる各コンポーネントの API
- [cache-relay/transport.md](./cache-relay/transport.md): `WebSocketServerEmulator` の設計
