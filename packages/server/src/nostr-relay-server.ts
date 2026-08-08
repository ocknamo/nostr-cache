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

interface NostrRelayServerOptions {
  port: number;
  host?: string;

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
    // キャッシュ優先度。指定 pubkey（npub / hex）の発行イベントと指定 kind の
    // イベントは maxSize 超過時に最後まで残り、TTL スイープの対象外になる
    // （maxSize は常に厳守）。不正な npub はコンストラクタで例外を投げる
    cachePriority?: { pubkeys?: string[]; kinds?: number[] };
  };

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
    // 鮮度ウィンドウ（kind → 秒）。指定 kind のキャッシュが N 秒以内に投入された
    // ものなら、その REQ を上流へ転送しない。replaceable な kind のみ指定可
    upstreamFreshness?: Record<number, number>;
  };

  healthCheck?: HealthCheckOptions;
}

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
  private healthServer: HealthServer;

  constructor(options: Partial<NostrRelayServerOptions> = {}) {
    this.options = {
      port: 8008,
      ...options,
    };

    // 既定は fake-indexeddb（インメモリ）、dbPath 指定時は node:sqlite による
    // 永続ストレージ（詳細は storage.ts）
    this.persistent = !!this.options.storageOptions?.dbPath;
    this.storage = createStorage({
      dbName: this.options.storageOptions?.dbName || 'NostrRelay',
      dbPath: this.options.storageOptions?.dbPath,
    });

    this.server = new WebSocketServer(this.options.port);

    // ストレージ上限・退避戦略は relay 経由で適用する
    // （relay が保存後に storage.enforceLimit を呼ぶ）
    this.relay = new NostrCacheRelay(this.storage, this.server, {
      maxSubscriptions: this.options.relay?.maxSubscriptions || 100,
      maxEventsPerRequest: this.options.relay?.maxEventsPerRequest || 500,
      storageMaxSize: this.options.storageOptions?.maxSize,
      cacheStrategy: this.options.storageOptions?.cacheStrategy,
      cachePriority: this.options.storageOptions?.cachePriority,
      ttl: this.options.relay?.ttl,
      ttlSweepInterval: this.options.relay?.ttlSweepInterval,
      validateEventsType: this.options.relay?.validateEvents !== false ? 'IMMEDIATELY' : 'NONE',
      upstreamRelays: this.options.relay?.upstreamRelays,
      upstreamEoseTimeout: this.options.relay?.upstreamEoseTimeout,
      upstreamFreshness: this.options.relay?.upstreamFreshness,
    });

    this.healthServer = new HealthServer(
      this.options.healthCheck,
      this.options.port,
      this.options.host,
      async () => {
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

  async start(): Promise<void> {
    if (this.persistent) {
      // stop() で閉じた永続 DB を再オープンする（初回起動時は no-op）。これにより
      // 同一インスタンスの stop() → start() の再利用が既定モードと対称になる
      const storage = this.storage as StorageAdapter & { open?: () => void };
      storage.open?.();
    }
    await this.relay.connect();
    await this.healthServer.start();
    logger.info(`Nostr relay server started on port ${this.options.port}`);
  }

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

  getHealthPort(): number | null {
    return this.healthServer.getBoundPort();
  }

  getConnectionCount(): number {
    return this.server.getConnectionCount();
  }

  async getEventCount(): Promise<number> {
    return this.storage.count();
  }

  getPort(): number {
    return this.options.port;
  }

  /**
   * キャッシュ優先度設定を実行時に差し替える（再起動不要）。
   * pubkey は npub / hex どちらでも指定でき、不正な値は例外を投げて現行設定を
   * 維持する。undefined（または空設定）で全ルールを解除。新しいルールは
   * 次回の退避・TTL スイープから反映される（退避済みイベントは戻らない）。
   */
  setCachePriority(input?: { pubkeys?: string[]; kinds?: number[] }): void {
    // relay 側の検証が通ってから自身の options も同期する（将来 relay を
    // 再生成するコードが入っても旧設定が復活しないように）
    this.relay.setCachePriority(input);
    this.options.storageOptions = { ...this.options.storageOptions, cachePriority: input };
  }
}
