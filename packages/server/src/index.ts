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
