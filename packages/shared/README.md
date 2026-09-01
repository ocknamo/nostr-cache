# Nostr Cache Shared

Nostr キャッシュプロジェクト内で共有される型定義とユーティリティ。

型・ワイヤーフォーマット・ユーティリティの一覧は
[doc/api.md](https://github.com/ocknamo/nostr-cache/blob/main/doc/api.md#nostr-cacheshared) を参照してください。

```typescript
import { type Filter, type NostrEvent, DEFAULT_RELAY_URLS } from '@nostr-cache/shared';

const filter: Filter = { kinds: [1], authors: ['...'], limit: 10 };
```
