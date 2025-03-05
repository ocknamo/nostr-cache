# Nostr Cache Shared

Nostrキャッシュプロジェクト内で共有される型定義とユーティリティ。

## 提供される型定義

- Nostrイベント型
- リレー通信インターフェース
- キャッシュ設定オプション

## 使用方法

```typescript
import { NostrEvent, RelayConnection, Filter } from '@nostr-cache/shared';

const event: NostrEvent = {
  id: '...',
  pubkey: '...',
  created_at: 1234567890,
  kind: 1,
  tags: [],
  content: 'Hello, Nostr!',
  sig: '...'
};

const filter: Filter = {
  kinds: [1],
  authors: ['...'],
  limit: 10
};
```

## 共有定数

```typescript
import { DEFAULT_RELAY_URLS } from '@nostr-cache/shared';

// デフォルトのリレーURLを使用
console.log(DEFAULT_RELAY_URLS);
