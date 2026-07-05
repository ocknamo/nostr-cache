// fake-indexeddb の polyfill は @nostr-cache/cache-relay より前に評価される必要がある。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、この副作用 import
// を最初に置かないと、Node 実行時に "IndexedDB API missing" で保存が失敗する。
// （現状サーバーストレージはインメモリ。詳細は ./storage.ts）
import 'fake-indexeddb/auto';
import { logger } from '@nostr-cache/shared';
import { NostrRelayServer } from './nostr-relay-server.js';

// CLIインターフェース
function main() {
  // 環境変数PORTが指定されていればそのポートを使用する
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const server = new NostrRelayServer(port !== undefined ? { port } : {});

  // シグナルハンドリング
  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });

  // サーバー起動
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

main();
