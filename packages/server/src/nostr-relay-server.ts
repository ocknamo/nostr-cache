/**
 * Nostr Relay Server
 *
 * NIP-01準拠のNostrリレーサーバー実装
 */

// fake-indexeddbの自動セットアップ
import 'fake-indexeddb/auto';
import { type Server as HttpServer, createServer } from 'node:http';
import {
  DexieStorage,
  NostrCacheRelay,
  type StorageAdapter,
  type TransportAdapter,
  WebSocketServer,
} from '@nostr-cache/cache-relay';
import { logger } from '@nostr-cache/shared';

/**
 * ヘルスチェックエンドポイントの設定
 */
interface HealthCheckOptions {
  // ヘルスチェックを有効にするか（デフォルト: true）
  enabled?: boolean;
  // ヘルスチェック用 HTTP ポート（デフォルト: WebSocket ポート + 1）
  port?: number;
  // ヘルスチェックのパス（デフォルト: '/health'）
  path?: string;
}

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

  // ヘルスチェック設定
  healthCheck?: HealthCheckOptions;
}

/**
 * ヘルスチェックのレスポンスボディ
 */
interface HealthCheckResponse {
  status: 'ok';
  // プロセスの稼働秒数
  uptime: number;
  // 現在の WebSocket 接続数
  connections: number;
  // 保存済みイベント数
  events: number;
}

/**
 * Nostrリレーサーバークラス
 * NIP-01準拠のNostrリレーサーバーを実装
 */
export class NostrRelayServer {
  // Depend on the transport/storage abstractions; getConnectionCount() and
  // getEventCount() are part of those contracts, so the concrete WebSocketServer
  // / DexieStorage instances are only needed at construction time.
  private server: TransportAdapter;
  private relay: NostrCacheRelay;
  private storage: StorageAdapter;
  private options: NostrRelayServerOptions;
  // ヘルスチェック用 HTTP サーバー（無効時 / 起動失敗時は null）
  private healthServer: HttpServer | null = null;

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
      storageMaxSize: this.options.storageOptions?.maxSize,
      maxSubscriptions: this.options.relay?.maxSubscriptions || 100,
      maxEventsPerRequest: this.options.relay?.maxEventsPerRequest || 500,
      validateEventsType: this.options.relay?.validateEvents !== false ? 'IMMEDIATELY' : 'NONE',
    });
  }

  /**
   * サーバーを起動
   *
   * @returns Promise resolving when the server is started
   */
  async start(): Promise<void> {
    await this.relay.connect();
    await this.startHealthServer();
    logger.info(`Nostr relay server started on port ${this.options.port}`);
  }

  /**
   * サーバーを停止
   *
   * @returns Promise resolving when the server is stopped
   */
  async stop(): Promise<void> {
    await this.stopHealthServer();
    await this.relay.disconnect();
    // ストレージのクリーンアップ
    await this.storage.clear();
    logger.info('Nostr relay server stopped');
  }

  /**
   * ヘルスチェックが有効かどうか
   *
   * @returns 有効なら true（明示的に false が指定されない限り有効）
   */
  private isHealthCheckEnabled(): boolean {
    return this.options.healthCheck?.enabled !== false;
  }

  /**
   * ヘルスチェック用ポートを取得（デフォルトは WebSocket ポート + 1）
   *
   * @returns ヘルスチェック用ポート番号
   */
  private getHealthCheckPort(): number {
    return this.options.healthCheck?.port ?? this.options.port + 1;
  }

  /**
   * ヘルスチェックのパスを取得（デフォルトは '/health'）
   *
   * @returns ヘルスチェックのパス
   */
  private getHealthCheckPath(): string {
    return this.options.healthCheck?.path ?? '/health';
  }

  /**
   * ヘルスチェック用 HTTP サーバーを起動する。
   *
   * 補助機能のため、ポート確保に失敗しても警告ログを残すだけでリレー本体は停止しない
   * （ヘルスチェックの障害がリレーの稼働を妨げないようにする）。
   *
   * @returns Promise resolving when the health server is started (or skipped)
   */
  private async startHealthServer(): Promise<void> {
    if (!this.isHealthCheckEnabled()) {
      return;
    }

    const path = this.getHealthCheckPath();
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      this.getEventCount()
        .then((events) => {
          const body: HealthCheckResponse = {
            status: 'ok',
            uptime: process.uptime(),
            connections: this.getConnectionCount(),
            events,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        })
        .catch((error) => {
          logger.error('Health check handler failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error' }));
        });
    });

    // 補助エンドポイントを Slowloris 等の接続保持型攻撃から守るためのタイムアウト。
    // ヘッダ／リクエスト全体を短時間で受け切れない接続は切断する。
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;

    const port = this.getHealthCheckPort();

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, this.options.host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });

      this.healthServer = server;
      logger.info(`Health check endpoint listening on port ${this.getHealthPort()} (path ${path})`);
    } catch (error) {
      logger.error(`Failed to start health check endpoint on port ${port}:`, error);
      // リレー本体には影響させない
      this.healthServer = null;
    }
  }

  /**
   * ヘルスチェック用 HTTP サーバーを停止する。
   *
   * @returns Promise resolving when the health server is stopped
   */
  private async stopHealthServer(): Promise<void> {
    if (!this.healthServer) {
      return;
    }

    const server = this.healthServer;
    this.healthServer = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 稼働中のヘルスチェックエンドポイントのポート番号を取得する。
   *
   * 設定値ではなく実際にバインドされたポートを返すため、`healthCheck.port: 0`
   * （動的割り当て）にも対応する。
   *
   * @returns リッスン中のポート番号。無効化されている、または起動に失敗した場合は null
   */
  getHealthPort(): number | null {
    const address = this.healthServer?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }

  /**
   * 接続数を取得
   *
   * @returns 現在の接続数
   */
  getConnectionCount(): number {
    return this.server.getConnectionCount();
  }

  /**
   * イベント数を取得
   *
   * @returns Promise resolving to the number of events
   */
  async getEventCount(): Promise<number> {
    return this.storage.count();
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
