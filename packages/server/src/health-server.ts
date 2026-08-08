import { type Server as HttpServer, createServer } from 'node:http';
import { logger } from '@nostr-cache/shared';

export interface HealthCheckOptions {
  /** 既定 true */
  enabled?: boolean;
  /** 既定は WebSocket ポート + 1 */
  port?: number;
  /** 既定 '/health' */
  path?: string;
}

export interface HealthCheckResponse {
  status: 'ok';
  /** プロセスの稼働秒数 */
  uptime: number;
  /** 現在の WebSocket 接続数 */
  connections: number;
  /** 保存済みイベント数 */
  events: number;
}

/**
 * リレー本体（WebSocket）とは別ポートで稼働する補助的な HTTP ヘルスチェック
 * エンドポイント。稼働状況は {@link snapshot} コールバックから取得するため、
 * このクラスは HTTP の受け付け・タイムアウト・ポート管理のみを担う。
 */
export class HealthServer {
  /** 無効時 / 起動失敗時は null */
  private server: HttpServer | null = null;

  constructor(
    private options: HealthCheckOptions | undefined,
    private wsPort: number,
    private host: string | undefined,
    private snapshot: () => Promise<HealthCheckResponse>
  ) {}

  private isEnabled(): boolean {
    return this.options?.enabled !== false;
  }

  private getPort(): number {
    return this.options?.port ?? this.wsPort + 1;
  }

  private getPath(): string {
    return this.options?.path ?? '/health';
  }

  /**
   * 補助機能のため、ポート確保に失敗しても警告ログを残すだけでリレー本体は停止しない。
   */
  async start(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const path = this.getPath();
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      this.snapshot()
        .then((body) => {
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

    const port = this.getPort();

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, this.host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });

      this.server = server;
      logger.info(`Health check endpoint listening on port ${this.getBoundPort()} (path ${path})`);
    } catch (error) {
      logger.error(`Failed to start health check endpoint on port ${port}:`, error);
      this.server = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

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
   * 設定値ではなく実際にバインドされたポートを返すため、`healthCheck.port: 0`
   * （動的割り当て）にも対応する。
   */
  getBoundPort(): number | null {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }
}
