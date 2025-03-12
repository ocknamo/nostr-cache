# Nostr Cache Relay

Nostrリレーとのやり取りをキャッシュするためのリレーパッケージです。

## 機能

- リレーからのイベント取得のキャッシュ
- 効率的なデータ取得と保存
- 設定可能なキャッシュ戦略

## インストール

```bash
npm install @nostr-cache/cache-relay
```

## 使用方法

```typescript
import { NostrCache } from '@nostr-cache/cache-relay';

const cache = new NostrCache({
  // 設定オプション
  maxSize: 1000,
  ttl: 3600000 // 1時間（ミリ秒）
});

// キャッシュを使用してリレーからデータを取得
const events = await cache.getEvents(filters);
```

## API ドキュメント

### NostrCache

キャッシュの主要クラス。

#### コンストラクタ

```typescript
constructor(options?: CacheOptions)
```

##### オプション

- `maxSize`: キャッシュに保存する最大アイテム数
- `ttl`: キャッシュアイテムの有効期限（ミリ秒）
- `strategy`: キャッシュ戦略（'LRU'、'FIFO'など）

#### メソッド

- `getEvents(filters: Filter[]): Promise<Event[]>`: フィルタに一致するイベントを取得
- `addEvent(event: Event): void`: イベントをキャッシュに追加
- `clearCache(): void`: キャッシュをクリア
- `invalidate(filter: Filter): void`: 特定のフィルタに一致するキャッシュを無効化
