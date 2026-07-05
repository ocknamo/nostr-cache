/**
 * Health check HTTP server
 *
 * リレー本体（WebSocket）とは別ポートで稼働する補助的な HTTP ヘルスチェック
 * エンドポイント。稼働状況のスナップショット取得は呼び出し側（NostrRelayServer）
 * から注入されるコールバックに委ねる。
 */

import { type Server as HttpServer, createServer } from 'node:http';
import { logger } from '@nostr-cache/shared';

/**
 * ヘルスチェックエンドポイントの設定
 */
export interface HealthCheckOptions {
  // ヘルスチェックを有効にするか（デフォルト: true）
  enabled?: boolean;
  // ヘルスチェック用 HTTP ポート（デフォルト: WebSocket ポート + 1）
  port?: number;
  // ヘルスチェックのパス（デフォルト: '/health'）
  path?: string;
}

/**
 * ヘルスチェックのレスポンスボディ
 */
export interface HealthCheckResponse {
  status: 'ok';
  // プロセスの稼働秒数
  uptime: number;
  // 現在の WebSocket 接続数
  connections: number;
  // 保存済みイベント数
  events: number;
}

/**
 * ヘルスチェック用 HTTP サーバー。
 *
 * リレーの稼働状況を JSON で返す補助エンドポイントを提供する。実際の稼働状況
 * （接続数・イベント数など）は {@link snapshot} コールバックから取得するため、
 * このクラスは HTTP の受け付け・タイムアウト・ポート管理のみを担う。
 */
export class HealthServer {
  // ヘルスチェック用 HTTP サーバー（無効時 / 起動失敗時は null）
  private server: HttpServer | null = null;

  /**
   * @param options ヘルスチェック設定（未指定なら既定で有効）
   * @param wsPort WebSocket ポート。既定ポート（+1）の導出に使う
   * @param host バインドするホスト
   * @param snapshot 現在の稼働状況スナップショットを返すコールバック
   */
  constructor(
    private options: HealthCheckOptions | undefined,
    private wsPort: number,
    private host: string | undefined,
    private snapshot: () => Promise<HealthCheckResponse>
  ) {}

  /**
   * ヘルスチェックが有効かどうか
   *
   * @returns 有効なら true（明示的に false が指定されない限り有効）
   */
  private isEnabled(): boolean {
    return this.options?.enabled !== false;
  }

  /**
   * ヘルスチェック用ポートを取得（デフォルトは WebSocket ポート + 1）
   *
   * @returns ヘルスチェック用ポート番号
   */
  private getPort(): number {
    return this.options?.port ?? this.wsPort + 1;
  }

  /**
   * ヘルスチェックのパスを取得（デフォルトは '/health'）
   *
   * @returns ヘルスチェックのパス
   */
  private getPath(): string {
    return this.options?.path ?? '/health';
  }

  /**
   * ヘルスチェック用 HTTP サーバーを起動する。
   *
   * 補助機能のため、ポート確保に失敗しても警告ログを残すだけでリレー本体は停止しない
   * （ヘルスチェックの障害がリレーの稼働を妨げないようにする）。
   *
   * @returns Promise resolving when the health server is started (or skipped)
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
      // リレー本体には影響させない
      this.server = null;
    }
  }

  /**
   * ヘルスチェック用 HTTP サーバーを停止する。
   *
   * @returns Promise resolving when the health server is stopped
   */
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
   * 稼働中のヘルスチェックエンドポイントのポート番号を取得する。
   *
   * 設定値ではなく実際にバインドされたポートを返すため、`healthCheck.port: 0`
   * （動的割り当て）にも対応する。
   *
   * @returns リッスン中のポート番号。無効化されている、または起動に失敗した場合は null
   */
  getBoundPort(): number | null {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }
}
