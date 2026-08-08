/** Options and defaults for {@link NostrCacheRelay}. */

import { normalizePubkey } from '@nostr-cache/shared';
import { isReplaceableKind } from '../event/event-kind.js';
import type { CachePriority } from '../storage/priority.js';
import type { CacheStrategy } from '../storage/storage-adapter.js';
import type { FreshnessWindows } from '../upstream/freshness.js';
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

export interface NostrRelayOptions {
  /** 既定 20 */
  maxSubscriptions?: number;

  /**
   * REQ 1 本あたりに返すストレージイベント数の上限。各フィルタ自身の `limit` の
   * 上にかぶせるリレー側のキャップ。既定 {@link DEFAULT_MAX_EVENTS}。
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
   * キャッシュ優先度。指定した pubkey（npub / hex どちらでも可）の発行イベント、
   * または指定 kind のイベントを優先イベントとして扱う。優先イベントは
   * {@link storageMaxSize} 超過時に最後まで残り（非優先を先に退避し、優先だけに
   * なったら通常の {@link cacheStrategy} 順で退避するので `storageMaxSize` は常に
   * 守られる）、{@link ttl} スイープの対象外になる。
   *
   * 不正な pubkey / kind はリレー生成時に例外。実行中の差し替えは
   * `NostrCacheRelay.setCachePriority()` で行う。
   */
  cachePriority?: { pubkeys?: string[]; kinds?: number[] };

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

  /** Node.js の WebSocket サーバー用 */
  port?: number;

  /**
   * 上流リレーの URL リスト。指定したときだけ透過キャッシュになる
   * （REQ はリードスルー、EVENT はライトスルー）。未指定・空配列なら
   * 「自分が保存済みのイベントのみ返す独立リレー」として動作する。
   */
  upstreamRelays?: string[];

  /**
   * リードスルー時、上流の EOSE を待ってクライアントへ EOSE を返す上限 (ms)。
   * 既定は `DEFAULT_SUBSCRIPTION_TIMEOUT`。上流が全滅していても、この時間で EOSE を返す。
   */
  upstreamEoseTimeout?: number;

  /**
   * 鮮度ウィンドウ。kind → 「その kind のキャッシュを新鮮とみなす秒数」（HTTP の
   * `max-age` 相当）。`{ 0: 3600 }` なら「1時間以内にキャッシュした kind 0 は上流に
   * 問い合わせない」。REQ のフィルタが replaceable イベント（`kinds` + `authors`）だけを
   * 要求し、要求した (kind, pubkey) すべてが窓の内側のキャッシュから返せた場合、
   * そのフィルタは上流へ転送しない。1 件でも古い・欠けている・列挙できない場合は
   * 従来どおり転送する。
   *
   * {@link upstreamRelays} と併用したときだけ意味を持ち、`getCachedAt` 対応の
   * ストレージ（`DexieStorage` / `SqliteStorage`）が必要。未対応なら警告 1 回で無効。
   *
   * Only replaceable kinds may be listed (0 / 3 / 10000–19999) — an addressable
   * or regular kind throws at relay construction time, as does a non-positive
   * window. See [doc/cache-relay/upstream.md](../../../../doc/cache-relay/upstream.md).
   */
  upstreamFreshness?: Record<number, number>;

  /**
   * テスト・高度用途向け: 上流プールの実装を差し替える。指定時は `upstreamRelays`
   * より優先され、リード/ライトスルーが有効になる。
   */
  upstreamPool?: UpstreamPool;
}

/** Apply the relay's option defaults to a caller-supplied options object. */
export function resolveRelayOptions(options: NostrRelayOptions): NostrRelayOptions {
  return {
    validateEventsType: 'IMMEDIATELY',
    maxSubscriptions: 20,
    ...options,
    // Guard against an explicit `undefined` clobbering the default
    maxEventsPerRequest: options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS,
    cachePriority: normalizeCachePriority(options.cachePriority),
  };
}

/**
 * Normalize a caller-supplied cache priority config: pubkeys are converted to
 * 64-char lowercase hex (decoding `npub1...` input), kinds are validated, and
 * both lists are deduplicated. Downstream code (eviction, TTL sweep) only ever
 * sees normalized hex. Returns undefined when there are no effective rules.
 *
 * @throws Error naming the offending entry on an invalid pubkey or kind
 */
export function normalizeCachePriority(input?: {
  pubkeys?: string[];
  kinds?: number[];
}): CachePriority | undefined {
  if (!input) {
    return undefined;
  }
  const pubkeys = [...new Set((input.pubkeys ?? []).map(normalizePubkey))];
  for (const kind of input.kinds ?? []) {
    // NIP-01 の kind は 0..65535
    if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
      throw new Error(`Invalid cachePriority kind (expected integer 0-65535): ${kind}`);
    }
  }
  const kinds = [...new Set(input.kinds ?? [])];
  if (pubkeys.length === 0 && kinds.length === 0) {
    return undefined;
  }
  return { pubkeys, kinds };
}

/**
 * Normalize a caller-supplied {@link NostrRelayOptions.upstreamFreshness} map
 * into the `Map` the freshness gate evaluates against.
 *
 * Deliberately not applied by {@link resolveRelayOptions}: unlike
 * `cachePriority`, whose input and normalized shapes are structurally
 * compatible, `Record<number, number>` and `Map` are not — folding it in would
 * force the public options type to admit both. `NostrCacheRelay` calls this
 * once at construction instead, so an invalid config still throws there.
 *
 * Non-replaceable kinds are rejected rather than ignored: a window on kind 1
 * can never be honoured (the result set is unbounded, so "the cache has
 * everything" is unknowable), and silently dropping it would leave the caller
 * with no way to see why their setting did nothing.
 *
 * @throws Error naming the offending entry on an invalid kind or window
 */
export function normalizeFreshnessWindows(
  input?: Record<number, number>
): FreshnessWindows | undefined {
  if (!input) {
    return undefined;
  }
  const windows = new Map<number, number>();
  for (const [rawKind, seconds] of Object.entries(input)) {
    const kind = Number(rawKind);
    // NIP-01 の kind は 0..65535
    if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
      throw new Error(`Invalid upstreamFreshness kind (expected integer 0-65535): ${rawKind}`);
    }
    if (!isReplaceableKind(kind)) {
      throw new Error(
        `Invalid upstreamFreshness kind ${kind}: only replaceable kinds (0, 3, 10000-19999) are supported`
      );
    }
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(
        `Invalid upstreamFreshness window for kind ${kind} (expected a positive finite number of seconds): ${seconds}`
      );
    }
    windows.set(kind, seconds);
  }
  return windows.size > 0 ? windows : undefined;
}
