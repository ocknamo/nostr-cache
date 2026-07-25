// fake-indexeddb の polyfill は @nostr-cache/cache-relay より前に評価される必要がある。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、この副作用 import
// を最初に置かないと、Node 実行時に "IndexedDB API missing" で保存が失敗する。
// （既定のサーバーストレージはインメモリ。NOSTR_DB_PATH 指定時は node:sqlite による
// 永続ストレージになり Dexie は使われないが、この import は無害。詳細は ./storage.ts）
import 'fake-indexeddb/auto';
import { logger } from '@nostr-cache/shared';
import { NostrRelayServer } from './nostr-relay-server.js';

// カンマ区切りの環境変数値を分解する（空要素は除去）
function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// CLIインターフェース
function main() {
  // 環境変数PORTが指定されていればそのポートを使用する
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  // 環境変数 NOSTR_DB_PATH が指定されていれば、そのパスの SQLite ファイルへ
  // 永続化する（オプトイン）。未指定なら従来どおりインメモリで再起動時に消える
  const dbPath = process.env.NOSTR_DB_PATH;
  // キャッシュ優先度（カンマ区切り）。pubkey は npub / hex どちらでも指定できる。
  // 不正な値は NostrRelayServer のコンストラクタが例外を投げ、起動時に失敗する
  const priorityPubkeys = splitCsv(process.env.NOSTR_CACHE_PRIORITY_PUBKEYS);
  const priorityKinds = splitCsv(process.env.NOSTR_CACHE_PRIORITY_KINDS).map(Number);
  const cachePriority =
    priorityPubkeys.length > 0 || priorityKinds.length > 0
      ? { pubkeys: priorityPubkeys, kinds: priorityKinds }
      : undefined;
  const storageOptions =
    dbPath || cachePriority
      ? { ...(dbPath ? { dbPath } : {}), ...(cachePriority ? { cachePriority } : {}) }
      : undefined;
  const server = new NostrRelayServer({
    ...(port !== undefined ? { port } : {}),
    ...(storageOptions ? { storageOptions } : {}),
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
