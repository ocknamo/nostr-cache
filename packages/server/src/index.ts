// fake-indexeddb の polyfill は @nostr-cache/cache-relay より前に評価される必要がある。
// Dexie はモジュール評価時に global の indexedDB をキャプチャするため、この副作用 import
// を最初に置かないと、Node 実行時に "IndexedDB API missing" で保存が失敗する。
// （既定のサーバーストレージはインメモリ。NOSTR_DB_PATH 指定時は node:sqlite による
// 永続ストレージになり Dexie は使われないが、この import は無害。詳細は ./storage.ts）
import 'fake-indexeddb/auto';
import { logger } from '@nostr-cache/shared';
import { NostrRelayServer } from './nostr-relay-server.js';

/** 空要素は除去する */
function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// 環境変数から NostrRelayServer を構築する。不正な設定値（npub / kind）は
// NostrRelayServer のコンストラクタまたはここでの kind パースが例外を投げる
function createServerFromEnv(): NostrRelayServer {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  // 指定時はそのパスの SQLite ファイルへ永続化する（オプトイン）。
  // 未指定なら従来どおりインメモリで再起動時に消える
  const dbPath = process.env.NOSTR_DB_PATH;
  // pubkey は npub / hex どちらでも指定できる
  const priorityPubkeys = splitCsv(process.env.NOSTR_CACHE_PRIORITY_PUBKEYS);
  const priorityKinds = splitCsv(process.env.NOSTR_CACHE_PRIORITY_KINDS).map((token) => {
    const kind = Number(token);
    // 数値化で元のトークンが失われる（NaN 等）前に、どの値が不正かを名指しで報告する
    if (!Number.isInteger(kind)) {
      throw new Error(`Invalid NOSTR_CACHE_PRIORITY_KINDS entry (expected integer): ${token}`);
    }
    return kind;
  });
  const cachePriority =
    priorityPubkeys.length > 0 || priorityKinds.length > 0
      ? { pubkeys: priorityPubkeys, kinds: priorityKinds }
      : undefined;
  const storageOptions =
    dbPath || cachePriority
      ? { ...(dbPath ? { dbPath } : {}), ...(cachePriority ? { cachePriority } : {}) }
      : undefined;
  return new NostrRelayServer({
    ...(port !== undefined ? { port } : {}),
    ...(storageOptions ? { storageOptions } : {}),
  });
}

function main() {
  let server: NostrRelayServer;
  try {
    server = createServerFromEnv();
  } catch (error) {
    // 起動失敗のハンドリングを server.start() 失敗時と揃える（生スタックを出さない）
    logger.error('Failed to configure server:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // シグナルハンドリング（SIGTERM は docker stop / systemd などからのクリーン終了用）
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

main();
