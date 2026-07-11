// fake-indexeddb の polyfill は @nostr-cache/cache-relay より前に評価される必要がある。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、この副作用 import
// を最初に置かないと、Node 実行時に "IndexedDB API missing" で保存が失敗する。
// （既定のサーバーストレージはインメモリ。NOSTR_DB_PATH 指定時は node:sqlite による
// 永続ストレージになり Dexie は使われないが、この import は無害。詳細は ./storage.ts）
import 'fake-indexeddb/auto';
import { logger } from '@nostr-cache/shared';
import { NostrRelayServer } from './nostr-relay-server.js';

// CLIインターフェース
function main() {
  // 環境変数PORTが指定されていればそのポートを使用する
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  // 環境変数 NOSTR_DB_PATH が指定されていれば、そのパスの SQLite ファイルへ
  // 永続化する（オプトイン）。未指定なら従来どおりインメモリで再起動時に消える
  const dbPath = process.env.NOSTR_DB_PATH;
  const server = new NostrRelayServer({
    ...(port !== undefined ? { port } : {}),
    ...(dbPath ? { storageOptions: { dbPath } } : {}),
  });

  // シグナルハンドリング（SIGTERM は docker stop / systemd などからのクリーン終了用）
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // サーバー起動
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

main();
