# 透過型キャッシュをクライアントに埋め込む

既存の Nostr クライアント（素の `WebSocket` で NIP-01 を話す実装）に、
**コードをほぼ変更せずに**ブラウザ内ローカルリレーをキャッシュとして挟む方法を説明します。

仕組みの中核は `@nostr-cache/cache-relay` の `WebSocketServerEmulator` です。
グローバルの `WebSocket` を差し替え、対象 URL への接続だけをブラウザ内リレー
（IndexedDB 永続化）に振り向けます。対象外の URL への接続は元の `WebSocket` に
そのまま委譲されるため、他の通信には影響しません。

```
┌─ ブラウザ ────────────────────────────────────────────┐
│                                                        │
│  Nostr クライアント                                     │
│    │ new WebSocket('ws://nostr-cache.invalid')          │
│    ▼                                                    │
│  WebSocketServerEmulator（グローバル WebSocket を横取り）│
│    │ NIP-01 (REQ / EVENT / EOSE / CLOSE / OK / NOTICE)  │
│    ▼                                                    │
│  NostrCacheRelay ──── DexieStorage（IndexedDB）          │
│                                                        │
│  ※ 対象 URL への接続はネットワークに一切出ない          │
│  ※ 対象外 URL（wss://…）は元の WebSocket で素通し        │
└────────────────────────────────────────────────────────┘
```

## 手順

### 1. 依存関係を追加する

```bash
npm install @nostr-cache/cache-relay @nostr-cache/shared
```

ブラウザ向けバンドルでは **`/browser` エントリポイント**から import してください。
ルートエントリは Node.js 専用の `WebSocketServer`（`ws` パッケージ依存）を含むため、
バンドラーによってはビルドできません。

### 2. アプリ起動時にローカルリレーを組み立てる

クライアントが最初の `new WebSocket()` を呼ぶ**前に** `relay.connect()` を完了させます
（グローバル `WebSocket` の差し替えは `connect()` 時に行われるため、それ以前に
生成されたソケットは横取りされません）。

```typescript
import {
  DexieStorage,
  NostrCacheRelay,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';

// インターセプトする URL。省略時は ws://nostr-cache.invalid
// （RFC 6761 予約 TLD のため、実在するサーバーと衝突しない）
const transport = new WebSocketServerEmulator('ws://nostr-cache.invalid');

const storage = new DexieStorage('my-app-cache'); // IndexedDB のデータベース名
const relay = new NostrCacheRelay(storage, transport, {
  validateEventsType: 'IMMEDIATELY', // 署名検証（'LAZY' / 'NONE' も可）
  maxSubscriptions: 20,              // クライアント毎の同時購読数上限
});

await relay.connect(); // ここでグローバル WebSocket が差し替わる
```

#### 代替: ホスト済みバンドルから起動する（npm を使わない場合）

ビルド構成に npm パッケージを足せない（あるいは足したくない）場合は、GitHub Pages で
配信している埋め込みバンドルから同じものを起動できます。`nostr-timeline.js` は
`<nostr-timeline>` の登録に加えて**リレー起動 API を named export しており**、
ウィジェットを DOM に置かなくても呼べます。組み立て（Dexie ストレージ・エミュレータ・
遅延検証・上流プール）は上の手順と同じものがパッケージ済みです。

```html
<script src="https://ocknamo.github.io/nostr-cache/nostr-timeline.js"></script>
<script>
  (async () => {
    const { acquireRelayHost } = globalThis.NostrTimelineEmbed;
    const host = await acquireRelayHost({ upstreamRelays: ['wss://nos.lol'] });
    // host.interceptUrl === 'ws://nostr-cache.invalid'
    // キャッシュを通したいクライアントは、この await のあとで初期化する
    // 後始末は await host.release()（最後の1つでリレーが停止し、WebSocket が戻る）
  })();
</script>
```

引き換えに次の点を受け入れることになります。

- リレーだけが欲しい場合も**ウィジェットのカスタム要素が読み込み時に登録され**、
  ウィジェット一式ぶんのバンドルを読むことになります。
- **バージョン付きの配信ではありません**（固定 URL の最新版を読みます）。
- `validateEventsType` の変更や、横取り URL に実リレーの URL を使う構成
  （後述の[パターン B](#対象-url-の指定パターン)）はできません。細かく制御したい場合は上の自前組み立てを使ってください。

引数・既定値・注意点（参照カウント、同一ページのウィジェットと設定を揃えること、
二重読み込み不可、バンドルサイズ）は
[packages/timeline-embed/README.md](../packages/timeline-embed/README.md#ウィジェットを置かずにページ内リレーだけ使うjs-api)
を参照してください。

### 3. クライアントは普通に接続する

以降、クライアント側は接続先 URL を対象 URL にするだけです。
NIP-01 のワイヤープロトコル（`REQ` / `EVENT` / `EOSE` / `CLOSE` / `OK` / `NOTICE`）が
そのまま通ります。

```typescript
const ws = new WebSocket('ws://nostr-cache.invalid');
ws.onopen = () => {
  ws.send(JSON.stringify(['REQ', 'my-sub', { kinds: [1], limit: 100 }]));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // ['EVENT', 'my-sub', event] → ['EOSE', 'my-sub'] の順で届く
};
```

投稿（`['EVENT', event]`）は署名検証を経て IndexedDB に保存され、`['OK', id, true]` が
返ります。保存されたイベントはページをリロードしても再購読で再生されます。

### 4. 後始末

```typescript
await relay.disconnect(); // 全接続を閉じ、元のグローバル WebSocket を復元
```

## 対象 URL の指定パターン

`WebSocketServerEmulator` のコンストラクタは単数または複数の URL を受け取ります。
URL は正規化して比較されるため、末尾スラッシュの有無は問いません。

```typescript
// A. 専用のローカル URL を使う（推奨・明示的）
new WebSocketServerEmulator('ws://nostr-cache.invalid');

// B. 実リレーの URL を横取りする（既存クライアントを無改修で差し替える場合）
new WebSocketServerEmulator(['wss://relay.example.com', 'wss://nos.lol']);
```

対象 URL は**コンストラクタ引数で確定**します。`relay.connect()` は内部で
`transport.start()` を引数なしで呼ぶため、connect 経由で対象 URL が変わることは
ありません（エミュレータを直接使う場合のみ `start(url)` で上書き可能）。

パターン B を使うと、既存クライアントの接続先設定を変えることなくキャッシュを
挟めます。ただし**次節の制約**に注意してください。

## 上流リレーへのリードスルー / ライトスルー（透過キャッシュ）

`upstreamRelays` を指定すると、ローカルリレーが上流実リレー群の手前に挟まる
**透過キャッシュ**として動作します。

- **リードスルー**: `REQ` を上流へも転送し、得たイベントを重複排除してローカルへ充填
  しつつクライアントへ返します。上流購読は CLOSE / 切断まで維持され、EOSE 後の新着も
  透過的に届きます。
- **ライトスルー**: `EVENT` をローカル保存後、上流へも転送します（fire-and-forget）。
- **鮮度ウィンドウ**: `upstreamFreshness` に kind ごとの秒数を指定すると、その kind の
  キャッシュが窓の内側にある間は上流へ問い合わせず、即座に EOSE を返します
  （HTTP キャッシュの `max-age` 相当）。**窓の内側の購読はライブ更新を受け取りません**。

```ts
const relay = new NostrCacheRelay(storage, transport, {
  upstreamRelays: ['wss://nos.lol', 'wss://relay.damus.io'],
  upstreamFreshness: {
    0: 3600,  // プロフィールは1時間キャッシュ優先
    3: 600,   // フォローリストは10分
  },
});
```

判定条件・設計上のトレードオフは [doc/cache-relay/upstream.md](./cache-relay/upstream.md)、
各オプションの意味と既定値は [doc/api.md](./api.md#interface-nostrrelayoptions) を参照してください。

パターン B（実リレー URL を横取り）でも、上流コネクタは差し替え前の
`WebSocket`（`getOriginalWebSocket()`）を使って実リレーへ接続するため、
横取り URL を上流に指定しても自己接続ループにはなりません。ただし横取り URL と
上流 URL が同一だと同じリレーへ往復するため、通常は横取り URL（`.invalid` など）と
実在する上流 URL を分けて指定してください。

## 制約・注意点

- **上流全滅中の投稿は失われます**（再送キューは未実装）。クライアントへの `OK` は
  ローカル保存の成否で返るため `true` になりますが、上流へは転送されません。
- **上流 AUTH（NIP-42）は未対応**です。認証が必要な上流リレーには接続できません。
- **差し替えのタイミング**: `relay.connect()` より前に生成された `WebSocket` は
  横取りできません。アプリの初期化順に注意してください。
- **グローバル差し替えの影響範囲**: `globalThis.WebSocket` を置き換えるため、
  差し替え前に `const WS = WebSocket` のようにコンストラクタ参照を保持している
  ライブラリには効きません。
- **Service Worker では代替できません**: Service Worker は fetch/XHR しか
  インターセプトできず、WebSocket は捕捉できません。透過型はこのエミュレータ方式が
  実質唯一の手段です。
- 透過型ではなく、リレーをライブラリとして直接呼ぶ**非透過の in-process API**
  （`relay.publishEvent()` / `relay.subscribe()`）もあります。使い分けは
  [packages/cache-relay/README.md](../packages/cache-relay/README.md) を参照してください。

## 実装例

このリポジトリの `packages/web-client` が本手順の実働サンプルです:

- 組み立て: [`packages/web-client/src/lib/local-relay.ts`](../packages/web-client/src/lib/local-relay.ts)
- クライアント側（rx-nostr による NIP-01 実装。接続・自動再接続・REQ の再送はライブラリ任せ）: [`packages/timeline-embed/src/lib/relay-connection.ts`](../packages/timeline-embed/src/lib/relay-connection.ts) — web-client も `@nostr-cache/timeline-embed/lib` からこれを使う
- 統合テスト（fake-indexeddb + 実エミュレータで NIP-01 一巡）: [`packages/web-client/src/lib/local-relay.spec.ts`](../packages/web-client/src/lib/local-relay.spec.ts)

```bash
npm run dev:web   # http://localhost:5173 で起動
```

## 埋め込みウィジェットとして使う

自分で組み立てる代わりに、本手順をパッケージ化した
[`@nostr-cache/timeline-embed`](../packages/timeline-embed/README.md) をそのまま
埋め込むこともできます。iframe（埋め込み先から隔離）と Web Component（埋め込み先ページ内で
動作）の 2 形態があり、後者は本ドキュメントの手順そのもの（パターン A の専用ローカル URL 方式）を
内部で実行します。1 ページにリレーは 1 つだけ起動して共有されるため、複数のウィジェットを
置いても上流への接続は増えません。使い方は
[packages/timeline-embed/README.md](../packages/timeline-embed/README.md) を参照してください。

透過キャッシュの動作（キャッシュ由来の可視化・コールド/ウォーム計測）は
公開デモで確認できます: <https://ocknamo.github.io/nostr-cache/>

## 関連ドキュメント

- [doc/concept.md](./concept.md): 透過キャッシュ構想の背景・全体像
- [doc/api.md](./api.md): API リファレンス
- [doc/cache-relay/upstream.md](./cache-relay/upstream.md): 上流透過キャッシュの設計
- [packages/cache-relay/README.md](../packages/cache-relay/README.md): パッケージ概要と2つの利用形態
