/**
 * Options and defaults for {@link NostrCacheRelay}.
 */

import type { CacheStrategy } from '../storage/storage-adapter.js';
import type { UpstreamPool } from '../upstream/upstream-types.js';

/**
 * Default relay-imposed cap on the number of stored events returned per REQ
 * subscription / in-process subscribe replay.
 */
export const DEFAULT_MAX_EVENTS = 500;

/**
 * Client ID used for subscriptions created through the in-process API
 * (`subscribe()` / `unsubscribe()`), as opposed to subscriptions created
 * by remote clients over the transport layer.
 */
export const LOCAL_CLIENT_ID = 'local';

/**
 * Nostr Cache Relay options
 * flat option
 *
 * 注意: 一部のオプションは現在実装中のため、完全にはサポートされていません。
 * 将来のバージョンで全機能が利用可能になる予定です。
 */
export interface NostrRelayOptions {
  /**
   * Maximum number of subscriptions per client
   * デフォルト値20
   */
  maxSubscriptions?: number;

  /**
   * Maximum number of stored events returned per REQ subscription
   * (relay-imposed cap applied on top of each filter's own `limit`).
   * デフォルト値500
   */
  maxEventsPerRequest?: number;

  /**
   * Maximum number of events to keep in storage. When set, after each saved
   * event the relay asks the storage adapter to evict down to this size
   * (see {@link cacheStrategy}). Disabled when undefined or non-positive.
   *
   * Requires a storage adapter implementing `enforceLimit` (DexieStorage
   * does); otherwise it has no effect.
   */
  storageMaxSize?: number;

  /**
   * Time-to-live in seconds for cached events. Events cached (saved to
   * storage) more than `ttl` seconds ago are deleted by a periodic background
   * sweep (see {@link ttlSweepInterval}) rather than filtered on every read.
   * Expiry counts from when the event entered this cache, not from the
   * event's own `created_at`.
   *
   * Trade-off: an expired event may still be returned for up to one sweep
   * interval before it is purged. Disabled when undefined or non-positive.
   *
   * Requires a storage adapter implementing `deleteExpired` (DexieStorage
   * does). If the adapter does not, the TTL silently has no effect aside from
   * a one-time warning logged on the first sweep.
   */
  ttl?: number;

  /**
   * Interval in seconds between TTL background sweeps when `ttl` is set.
   * Defaults to 60. Smaller values reduce staleness at the cost of more
   * frequent delete passes.
   */
  ttlSweepInterval?: number;

  /**
   * Eviction strategy used when `storageMaxSize` is exceeded: `FIFO` (oldest
   * `created_at` first), `LRU` (least recently read first) or `LFU` (least
   * frequently read first). Defaults to `FIFO`.
   */
  cacheStrategy?: CacheStrategy;

  /**
   * Whether to validate events
   */
  validateEventsType?: 'NONE' | 'IMMEDIATELY' | 'LAZY';

  /**
   * Interval in seconds between background validation passes when
   * `validateEventsType` is `'LAZY'`. Defaults to 60.
   */
  lazyValidateInterval?: number;

  /**
   * Number of events validated per background pass when `validateEventsType`
   * is `'LAZY'`. Defaults to 100.
   */
  lazyValidateBatchSize?: number;

  /**
   * Port for WebSocket server (Node.js only)
   */
  port?: number;

  /**
   * 上流リレーの URL リスト。指定したときだけリードスルー / ライトスルーが有効になる。
   * 未指定（または空配列）の場合は従来どおり「自分が保存済みのイベントのみ返す独立
   * リレー」として動作する。
   *
   * List of upstream relay URLs. When set (non-empty), the relay becomes a
   * transparent cache: REQ is read-through (forwarded upstream, results
   * backfilled) and EVENT is write-through (forwarded upstream). When unset,
   * behaviour is unchanged (an independent relay).
   */
  upstreamRelays?: string[];

  /**
   * リードスルー時、上流の EOSE を待ってクライアントへ EOSE を返す上限 (ms)。
   * 既定は `DEFAULT_SUBSCRIPTION_TIMEOUT`。上流が全滅していても、この時間で EOSE を返す。
   *
   * Max time (ms) to hold the client's EOSE waiting for the aggregated upstream
   * EOSE. Defaults to `DEFAULT_SUBSCRIPTION_TIMEOUT`.
   */
  upstreamEoseTimeout?: number;

  /**
   * 上流リレーへの接続タイムアウト (ms)。既定は `DEFAULT_CONNECTION_TIMEOUT`。
   *
   * Connect timeout (ms) for each upstream relay. Defaults to
   * `DEFAULT_CONNECTION_TIMEOUT`.
   */
  upstreamConnectionTimeout?: number;

  /**
   * テスト・高度用途向け: 上流プールの実装を差し替える。指定時は `upstreamRelays`
   * より優先され、リード/ライトスルーが有効になる。
   *
   * Test / advanced hook: inject a custom upstream pool. Takes precedence over
   * `upstreamRelays` and enables read/write-through when present.
   */
  upstreamPool?: UpstreamPool;
}

/**
 * Apply the relay's option defaults to a caller-supplied options object.
 *
 * Sets `validateEventsType` (IMMEDIATELY), `maxSubscriptions` (20) and
 * `maxEventsPerRequest` ({@link DEFAULT_MAX_EVENTS}). The last is resolved with
 * `??` so an explicit `undefined` cannot clobber the default.
 *
 * @param options Caller-supplied options
 * @returns A new options object with defaults applied
 */
export function resolveRelayOptions(options: NostrRelayOptions): NostrRelayOptions {
  return {
    validateEventsType: 'IMMEDIATELY',
    maxSubscriptions: 20,
    ...options,
    // Guard against an explicit `undefined` clobbering the default
    maxEventsPerRequest: options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS,
  };
}
