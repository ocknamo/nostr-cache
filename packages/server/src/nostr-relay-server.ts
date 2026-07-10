/**
 * Nostr Relay Server
 *
 * NIP-01準拠のNostrリレーサーバー実装
 */

import {
  type CacheStrategy,
  NostrCacheRelay,
  type StorageAdapter,
  type TransportAdapter,
  WebSocketServer,
} from '@nostr-cache/cache-relay';
import { logger } from '@nostr-cache/shared';
import { type HealthCheckOptions, HealthServer } from './health-server.js';
import { createStorage } from './storage.js';

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
    // SQLite データベースのファイルパス。指定すると node:sqlite による永続
    // ストレージを使用し、再起動をまたいでイベントが保持される（dbName は無視）。
    // 未指定なら従来どおり fake-indexeddb（インメモリ・非永続）
    dbPath?: string;
    // 保存イベント数の上限。超過時は古いイベントから退避（未指定で無制限）
    maxSize?: number;
    // 退避戦略（FIFO: 作成が古い順 / LRU: 読み出しが古い順 / LFU: 読み出し頻度が低い順）
    cacheStrategy?: CacheStrategy;
  };

  // リレー設定（NostrCacheRelayに渡すオプション）
  relay?: {
    maxSubscriptions?: number;
    maxEventsPerRequest?: number;
    validateEvents?: boolean;
    // 鮮度切れイベントを削除する TTL（秒）。未指定で無効。バックグラウンドの
    // 定期スイープで削除されるため、最大で ttlSweepInterval 秒ぶん古い結果を返しうる
    ttl?: number;
    // TTL スイープの実行間隔（秒）。既定 60
    ttlSweepInterval?: number;
    // 上流リレーの URL リスト。指定するとリードスルー / ライトスルーが有効になり、
    // このサーバーは上流リレー群の手前に挟まる透過キャッシュとして動作する。
    // 未指定なら従来どおり自分が保存したイベントのみ返す独立リレー。
    upstreamRelays?: string[];
    // 上流の EOSE を待ってクライアントへ EOSE を返す上限（ミリ秒）
    upstreamEoseTimeout?: number;
    // 上流リレーへの接続タイムアウト（ミリ秒）
    upstreamConnectionTimeout?: number;
  };

  // ヘルスチェック設定
  healthCheck?: HealthCheckOptions;
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
  // 永続ストレージ（dbPath 指定）かどうか。stop() の挙動を分ける
  private persistent: boolean;
  // ヘルスチェック用 HTTP サーバー（補助エンドポイント）
  private healthServer: HealthServer;

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

    // ストレージアダプタの初期化。既定は fake-indexeddb（インメモリ）、
    // dbPath 指定時は node:sqlite による永続ストレージ（詳細は storage.ts）
    this.persistent = !!this.options.storageOptions?.dbPath;
    this.storage = createStorage({
      dbName: this.options.storageOptions?.dbName || 'NostrRelay',
      dbPath: this.options.storageOptions?.dbPath,
    });

    // WebSocketサーバーの作成
    this.server = new WebSocketServer(this.options.port);

    // リレーの初期化。ストレージ上限・退避戦略は relay 経由で適用する
    // （relay が保存後に storage.enforceLimit を呼ぶ）
    this.relay = new NostrCacheRelay(this.storage, this.server, {
      maxSubscriptions: this.options.relay?.maxSubscriptions || 100,
      maxEventsPerRequest: this.options.relay?.maxEventsPerRequest || 500,
      storageMaxSize: this.options.storageOptions?.maxSize,
      cacheStrategy: this.options.storageOptions?.cacheStrategy,
      ttl: this.options.relay?.ttl,
      ttlSweepInterval: this.options.relay?.ttlSweepInterval,
      validateEventsType: this.options.relay?.validateEvents !== false ? 'IMMEDIATELY' : 'NONE',
      // 上流リレー（リード/ライトスルー）。未指定なら独立リレーのまま
      upstreamRelays: this.options.relay?.upstreamRelays,
      upstreamEoseTimeout: this.options.relay?.upstreamEoseTimeout,
      upstreamConnectionTimeout: this.options.relay?.upstreamConnectionTimeout,
    });

    // ヘルスチェック用 HTTP サーバー。稼働状況のスナップショットは本サーバーから注入する
    this.healthServer = new HealthServer(
      this.options.healthCheck,
      this.options.port,
      this.options.host,
      async () => {
        // 元実装と同じく、まずイベント数を取得してから uptime / connections を読む
        const events = await this.getEventCount();
        return {
          status: 'ok',
          uptime: process.uptime(),
          connections: this.getConnectionCount(),
          events,
        };
      }
    );
  }

  /**
   * サーバーを起動
   *
   * @returns Promise resolving when the server is started
   */
  async start(): Promise<void> {
    await this.relay.connect();
    await this.healthServer.start();
    logger.info(`Nostr relay server started on port ${this.options.port}`);
  }

  /**
   * サーバーを停止
   *
   * @returns Promise resolving when the server is stopped
   */
  async stop(): Promise<void> {
    await this.healthServer.stop();
    await this.relay.disconnect();
    if (this.persistent) {
      // 永続モードではデータを保持したまま DB を閉じる（WAL のチェックポイント +
      // ファイルハンドル解放）。close は共有 StorageAdapter 契約外のため
      // ダックタイピングで呼ぶ
      const storage = this.storage as StorageAdapter & { close?: () => void };
      storage.close?.();
    } else {
      // インメモリモードは従来どおりストレージをクリーンアップ
      await this.storage.clear();
    }
    logger.info('Nostr relay server stopped');
  }

  /**
   * 稼働中のヘルスチェックエンドポイントのポート番号を取得する。
   *
   * @returns リッスン中のポート番号。無効化されている、または起動に失敗した場合は null
   */
  getHealthPort(): number | null {
    return this.healthServer.getBoundPort();
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
