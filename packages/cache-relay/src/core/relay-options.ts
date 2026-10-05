/** {@link NostrCacheRelay} のオプションと既定値。仕様は doc/api.md を参照。 */

import { normalizePubkey } from '@nostr-cache/shared';
import { isReplaceableKind } from '../event/event-kind.js';
import { normalizeRelayUrl } from '../outbox/relay-list.js';
import type { CachePriority } from '../storage/priority.js';
import type { CacheStrategy } from '../storage/storage-adapter.js';
import type { FreshnessWindows } from '../upstream/freshness.js';
import type { UpstreamPool } from '../upstream/upstream-types.js';

export const DEFAULT_MAX_EVENTS = 500;

/** 秒。リレーリストは滅多に変わらないので、数時間遅れても宛先が外れる人は少ない。 */
export const DEFAULT_RELAY_LIST_FRESHNESS = 21_600;

/** transport 経由のクライアントと区別するための、in-process 購読の clientId。 */
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
   * 最大保存件数。定期スイープで退避するため、超過したまま最大
   * {@link storageSweepInterval} 秒ぶん保持しうる（超過を検知したら約 90% まで
   * 落とす）。`enforceLimit` 対応ストレージが必要。未指定・非正で無効。
   */
  storageMaxSize?: number;

  /** 上限チェックの実行間隔（秒）。既定 600 */
  storageSweepInterval?: number;

  /**
   * キャッシュ投入からの生存秒数。定期スイープで削除するため、期限切れイベントを
   * 最大 {@link ttlSweepInterval} 秒ぶん返しうる。`deleteExpired` 対応ストレージが
   * 必要。未指定・非正で無効。
   */
  ttl?: number;

  /** TTL スイープの実行間隔（秒）。既定 60 */
  ttlSweepInterval?: number;

  /** {@link storageMaxSize} 超過時の退避戦略。既定 `FIFO` */
  cacheStrategy?: CacheStrategy;

  /**
   * 優先イベント（指定 pubkey の発行イベント / 指定 kind）は退避を後回しにし、
   * {@link ttl} スイープの対象外にする。pubkey は npub / hex どちらでも可。
   * 不正な値はリレー生成時に例外。実行中の差し替えは `setCachePriority()`。
   */
  cachePriority?: { pubkeys?: string[]; kinds?: number[] };

  /** 既定 `IMMEDIATELY` */
  validateEventsType?: 'NONE' | 'IMMEDIATELY' | 'LAZY';

  /** `LAZY` のバックグラウンド検証間隔（秒）。既定 60 */
  lazyValidateInterval?: number;

  /** `LAZY` の 1 回あたり検証件数。既定 100 */
  lazyValidateBatchSize?: number;

  /** Node.js の WebSocket サーバー用 */
  port?: number;

  /**
   * 上流リレーの URL リスト。指定したときだけ透過キャッシュになる。
   * 未指定・空配列なら「自分が保存済みのイベントのみ返す独立リレー」。
   */
  upstreamRelays?: string[];

  /**
   * 上流の EOSE を待ってクライアントへ EOSE を返す上限 (ms)。
   * 既定は `DEFAULT_SUBSCRIPTION_TIMEOUT`。上流が全滅していてもこの時間で返す。
   */
  upstreamEoseTimeout?: number;

  /**
   * 鮮度ウィンドウ（kind → 秒）。指定できるのは replaceable kind のみで、それ以外や
   * 非正の秒はリレー生成時に例外。`getCachedAt` 対応ストレージが必要で、未対応なら
   * 警告 1 回で無効。判定条件は doc/cache-relay/upstream.md 第5節を参照。
   */
  upstreamFreshness?: Record<number, number>;

  /**
   * アウトボックスモデル（NIP-65）。`indexRelays` は著者の kind 10002 を引く先で、
   * 空・未指定なら無効。`wss:` の公開ホストでない URL はリレー生成時に例外。
   * 10002 の鮮度は `upstreamFreshness[10002]`、無ければ {@link DEFAULT_RELAY_LIST_FRESHNESS}。
   */
  outbox?: { indexRelays?: string[] };

  /**
   * テスト・高度用途向けに上流プールの実装を差し替える。
   * 指定時は {@link upstreamRelays} より優先される。
   */
  upstreamPool?: UpstreamPool;
}

export function resolveRelayOptions(options: NostrRelayOptions): NostrRelayOptions {
  return {
    validateEventsType: 'IMMEDIATELY',
    maxSubscriptions: 20,
    ...options,
    // 明示的な undefined が既定値を潰さないようにする
    maxEventsPerRequest: options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS,
    cachePriority: normalizeCachePriority(options.cachePriority),
  };
}

/**
 * pubkey を hex へ揃えて重複を除く。退避・TTL スイープ側は正規化済み hex しか見ない。
 * 実効ルールが無ければ undefined。
 *
 * @throws Error 不正な pubkey / kind。該当の値をメッセージに含める
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
 * {@link resolveRelayOptions} に畳み込まないのは、`Record` と `Map` が構造的に
 * 互換でなく、公開オプション型が両方を受け入れる形になってしまうため。
 * 代わりに `NostrCacheRelay` が構築時に 1 回呼ぶ。
 *
 * replaceable 以外を無視ではなく例外にするのは、kind 1 のような窓は結果集合が
 * 無限で「キャッシュが全部持っている」を判定しようがなく、黙って落とすと設定が
 * 効かない理由を利用者が知れないため。
 *
 * @throws Error 不正な kind / 窓。該当の値をメッセージに含める
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

/**
 * 正規化済みのインデックスリレー。無効なら undefined。
 *
 * @throws Error 宛先にできない URL。該当の値をメッセージに含める
 */
export function normalizeIndexRelays(outbox?: { indexRelays?: string[] }): string[] | undefined {
  const urls = new Set<string>();
  for (const raw of outbox?.indexRelays ?? []) {
    const url = normalizeRelayUrl(raw);
    if (!url) {
      throw new Error(`Invalid outbox index relay (expected a public wss:// URL): ${raw}`);
    }
    urls.add(url);
  }
  return urls.size > 0 ? [...urls] : undefined;
}
