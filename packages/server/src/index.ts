/**
 * Nostr Relay Server
 *
 * NIP-01準拠のNostrリレーサーバー実装
 */

// fake-indexeddbの自動セットアップ
import 'fake-indexeddb/auto';
import { NostrCacheRelay } from '@nostr-cache/cache-relay';
import { DexieStorage } from '@nostr-cache/cache-relay/dist/storage/DexieStorage';
import { WebSocketServer } from '@nostr-cache/cache-relay/dist/transport/WebSocketServer';
import { logger } from '@nostr-cache/shared';

/**
 * Nostrリレーサーバーの設定オプション
 */
interface NostrRelayServerOptions {
  // サーバー設定
  port: number;
  host?: string;

  // ストレージ設定
  storageOptions?: {
    dbName?: string;
    maxSize?: number;
  };

  // リレー設定（NostrCacheRelayに渡すオプション）
  relay?: {
    maxSubscriptions?: number;
    maxEventsPerRequest?: number;
    validateEvents?: boolean;
  };
}

/**
 * Nostrリレーサーバークラス
 * NIP-01準拠のNostrリレーサーバーを実装
 */
class NostrRelayServer {
  private server: WebSocketServer;
  private relay: NostrCacheRelay;
  private storage: DexieStorage;
  private options: NostrRelayServerOptions;

  /**
   * NostrRelayServerのインスタンスを作成
   *
   * @param options 設定オプション
   */
  constructor(options: Partial<NostrRelayServerOptions> = {}) {
    // デフォルト設定とマージ
    this.options = {
      port: 8008,
      ...options,
    };

    // fake-indexeddbを使用したDexieStorageの初期化
    this.storage = new DexieStorage(this.options.storageOptions?.dbName || 'NostrRelay');

    // WebSocketサーバーの作成
    this.server = new WebSocketServer(this.options.port);

    // リレーの初期化
    this.relay = new NostrCacheRelay(this.storage, this.server, {
      storage: 'indexeddb', // fake-indexeddbを使用
      storageOptions: {
        dbName: this.options.storageOptions?.dbName,
        maxSize: this.options.storageOptions?.maxSize,
      },
      maxSubscriptions: this.options.relay?.maxSubscriptions || 100,
      maxEventsPerRequest: this.options.relay?.maxEventsPerRequest || 500,
      validateEvents: this.options.relay?.validateEvents !== false,
    });
  }

  /**
   * サーバーを起動
   *
   * @returns Promise resolving when the server is started
   */
  async start(): Promise<void> {
    await this.relay.connect();
    logger.info(`Nostr relay server started on port ${this.options.port}`);
  }

  /**
   * サーバーを停止
   *
   * @returns Promise resolving when the server is stopped
   */
  async stop(): Promise<void> {
    await this.relay.disconnect();
    // ストレージのクリーンアップ
    await this.storage.clear();

    // fake-indexeddbのリセット - グローバル変数の再代入を避ける
    try {
      const resetMethod = require('fake-indexeddb/lib/FDBFactory').reset;
      if (typeof resetMethod === 'function') {
        resetMethod();
        logger.debug('IndexedDB reset successful');
      }
    } catch (error) {
      logger.warn('Failed to reset IndexedDB:', error);
    }

    logger.info('Nostr relay server stopped');
  }

  /**
   * 接続数を取得
   *
   * @returns 現在の接続数
   */
  getConnectionCount(): number {
    // 実装が必要
    return 0;
  }

  /**
   * イベント数を取得
   *
   * @returns Promise resolving to the number of events
   */
  async getEventCount(): Promise<number> {
    // 実装が必要
    return 0;
  }

  /**
   * サーバーが使用しているポート番号を取得
   *
   * @returns ポート番号
   */
  getPort(): number {
    return this.options.port;
  }
}

// CLIインターフェース
if (require.main === module) {
  const server = new NostrRelayServer();

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

export { NostrRelayServer };
