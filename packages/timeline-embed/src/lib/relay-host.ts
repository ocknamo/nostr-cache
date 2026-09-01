/**
 * ページ内キャッシュリレーの起動と共有。
 *
 * シングルトンなのは、2 つ目のエミュレータが**差し替え済み**のコンストラクタを
 * 「元の WebSocket」として掴んでしまい、復元の順序次第でページの WebSocket が
 * 死ぬため。同じ IndexedDB を二重に開くことと、上流への接続が N 倍になることも防ぐ。
 *
 * 購読はウィジェットごとに独立する（各自が `new WebSocket(interceptUrl)` を開き、
 * 別々の clientId を持つ）。in-process の `subscribe()` を使わないのは、その
 * `event` コールバックがどの購読由来かを言えないため。
 */

import {
  type CachePriority,
  type CacheStrategy,
  DexieStorage,
  NostrCacheRelay,
  UpstreamRelayPool,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';
import { CacheMetrics } from './cache-metrics.ts';
import { InstrumentedUpstreamPool } from './instrumented-upstream-pool.ts';

/** RFC 6761 予約の `.invalid` は解決しえないので、横取り漏れが実サーバへ届かない。 */
export const DEFAULT_INTERCEPT_URL = 'ws://nostr-cache.invalid';
export const DEFAULT_DB_NAME = 'nostr-cache-embed';
/** Short enough that the ✓ badges appear while the user is still looking. */
export const DEFAULT_LAZY_VALIDATE_INTERVAL = 5;
/**
 * kind 0 の鮮度ウィンドウ。ウィジェットはカードが画面に入るたび著者ごとに 1 本引くので、
 * 窓が無いと持っているプロフィールでも毎回上流へ REQ が出る。
 *
 * 1 日にしているのは、プロフィールが実際に変わる時間尺がその程度で、同じページに
 * 日内で戻ってくる読者が普通だから。`profile-freshness` で短くできる。
 */
export const DEFAULT_PROFILE_FRESHNESS = 86_400;
/**
 * kind 3 の鮮度ウィンドウ。`<nostr-follow-timeline>` は kind 3 が届くまで
 * タイムラインの REQ を組めない（最大 5 秒待つ）ので、この窓が初回描画の速さを決める。
 *
 * プロフィールの 1 日より短いのは、古いリストは見た目ではなく**どの投稿が出るか**を
 * 変えてしまうため。
 */
export const DEFAULT_FOLLOWS_FRESHNESS = 3600;

/**
 * 他の設定と違い既定で有効。IndexedDB は**埋め込み先オリジン**の容量を使うので、
 * 他人のクォータを無制限に使う既定を埋め込み側が選ぶわけにはいかない。
 */
export const DEFAULT_STORAGE_MAX_SIZE = 5000;

/**
 * リレー既定の FIFO を上書きする。FIFO は `created_at` 基準なので、何度読んでいても
 * 何年も前に公開されたプロフィールから落ちる。読み出しの追跡は戦略によらず走るため
 * LRU にしても増えるコストは無い。
 */
export const DEFAULT_CACHE_STRATEGY: CacheStrategy = 'LRU';

/**
 * 最後に退避する kind。上の鮮度ウィンドウの土台なので、退避すると窓が省くはずだった
 * 上流往復が発生し、kind 3 を失ったフォロータイムラインは描画自体が止まる。
 * 属性にしていないのは、好みではなくこのウィジェットの読み方から決まるため。
 */
const CACHE_PRIORITY: CachePriority = { kinds: [0, 3] };

export type { CacheStrategy };

export interface RelayHostConfig {
  /** 空ならキャッシュのみのリレーになる。 */
  upstreamRelays?: string[];
  dbName?: string;
  interceptUrl?: string;
  lazyValidateInterval?: number;
  /**
   * kind 0 の鮮度ウィンドウ（秒）。0 以下で無効。リレー自身は非正の窓を例外にするので、
   * ここで落として「無効」を起動失敗にしないようにしている。
   */
  profileFreshness?: number;
  /** kind 3 の鮮度ウィンドウ（秒）。{@link RelayHostConfig.profileFreshness} と同じ扱い。 */
  followsFreshness?: number;
  /** 0 以下で上限なし。縛るのはページ共有の DB であって 1 ウィジェットではない。 */
  storageMaxSize?: number;
  /** JS から呼ぶ場合のみ。上限を選ぶことは退避順序を選ぶことではないので属性は無い。 */
  cacheStrategy?: CacheStrategy;
}

interface ResolvedConfig extends Required<RelayHostConfig> {}

export interface RelayHost {
  relay: NostrCacheRelay;
  storage: DexieStorage;
  metrics: CacheMetrics;
  interceptUrl: string;
  getConnectedUpstreams(): number;
  /** 最後の 1 つを release した時点でリレーが停止する。 */
  release(): Promise<void>;
}

type SharedHost = Omit<RelayHost, 'release'>;

interface HostState {
  config: ResolvedConfig;
  promise: Promise<SharedHost>;
  refCount: number;
  stop: () => Promise<void>;
}

let current: HostState | undefined;
/**
 * 進行中の前ホストの停止処理。これが解決するまで次を起動してはいけない。
 * `disconnect()` が `globalThis.WebSocket` を戻すので、早く起動すると差し替え済みの
 * コンストラクタを「元の WebSocket」として掴む。
 */
let pendingStop: Promise<void> | undefined;

function resolveConfig(config: RelayHostConfig): ResolvedConfig {
  return {
    upstreamRelays: config.upstreamRelays ?? [],
    dbName: config.dbName ?? DEFAULT_DB_NAME,
    interceptUrl: config.interceptUrl ?? DEFAULT_INTERCEPT_URL,
    lazyValidateInterval: config.lazyValidateInterval ?? DEFAULT_LAZY_VALIDATE_INTERVAL,
    profileFreshness: config.profileFreshness ?? DEFAULT_PROFILE_FRESHNESS,
    followsFreshness: config.followsFreshness ?? DEFAULT_FOLLOWS_FRESHNESS,
    storageMaxSize: config.storageMaxSize ?? DEFAULT_STORAGE_MAX_SIZE,
    cacheStrategy: config.cacheStrategy ?? DEFAULT_CACHE_STRATEGY,
  };
}

/**
 * kind ごとに独立して無効にできる必要があるため 1 つの式にまとめていない。
 * 非正の窓は `{ 3: 0 }` として渡さず省く（`normalizeFreshnessWindows` が例外を投げ、
 * `relay.connect()` ごと失敗するため）。全 kind が無効なら `undefined`。
 */
function freshnessWindows(config: ResolvedConfig): Record<number, number> | undefined {
  const windows: Record<number, number> = {};
  if (config.profileFreshness > 0) {
    windows[0] = config.profileFreshness;
  }
  if (config.followsFreshness > 0) {
    windows[3] = config.followsFreshness;
  }
  return Object.keys(windows).length > 0 ? windows : undefined;
}

/**
 * Warn when a later widget asks for settings the running host cannot provide.
 * Reconfiguring would disturb the widgets already streaming from it, so the
 * first configuration wins by design.
 */
function warnOnConflict(running: ResolvedConfig, requested: ResolvedConfig): void {
  const differing = (Object.keys(requested) as (keyof ResolvedConfig)[]).filter(
    (key) => JSON.stringify(running[key]) !== JSON.stringify(requested[key])
  );
  if (differing.length === 0) {
    return;
  }
  console.warn(
    `[nostr-timeline] A relay is already running on this page; reusing it and ignoring ${differing.join(
      ', '
    )}. Every widget on a page shares one relay — give them matching attributes, or embed them in iframes to isolate them.`
  );
}

async function startHost(config: ResolvedConfig): Promise<SharedHost> {
  const metrics = new CacheMetrics();
  const storage = new DexieStorage(config.dbName);
  const transport = new WebSocketServerEmulator(config.interceptUrl);
  try {
    return await connectHost(config, metrics, storage, transport);
  } catch (error) {
    // `connect()` はグローバルを差し替えたあとで失敗しうる。差し替えを残すと次の
    // ホストが差し替え済みのコンストラクタを「元の WebSocket」として掴む。
    await transport.stop();
    throw error;
  }
}

async function connectHost(
  config: ResolvedConfig,
  metrics: CacheMetrics,
  storage: DexieStorage,
  transport: WebSocketServerEmulator
): Promise<SharedHost> {
  const upstreamPool = config.upstreamRelays.length
    ? new InstrumentedUpstreamPool(
        new UpstreamRelayPool(config.upstreamRelays, {
          // connect 時に解決して、上流接続が差し替え前の WebSocket を使うようにする
          // （エミュレータへ戻るループを防ぐ）。
          webSocketFactory: () => transport.getOriginalWebSocket?.() ?? globalThis.WebSocket,
        }),
        {
          onUpstreamEvent: (eventId, relayUrl) => metrics.recordUpstreamEvent(eventId, relayUrl),
        }
      )
    : undefined;

  const relay = new NostrCacheRelay(storage, transport, {
    // 検証はリレーが背後で行い結果を永続化するので、ウィジェット側は暗号処理をしない。
    validateEventsType: 'LAZY',
    lazyValidateInterval: config.lazyValidateInterval,
    maxSubscriptions: 20,
    upstreamPool,
    // 「いつ上流に聞き直すか」の方針は、それに答えるキャッシュ側に置く。
    upstreamFreshness: freshnessWindows(config),
    // 非正はそのまま渡す。鮮度ウィンドウと違い、リレーはこれを「上限なし」と定義している。
    storageMaxSize: config.storageMaxSize,
    cacheStrategy: config.cacheStrategy,
    cachePriority: CACHE_PRIORITY,
  });

  await relay.connect();

  return {
    relay,
    storage,
    metrics,
    interceptUrl: config.interceptUrl,
    getConnectedUpstreams: () => upstreamPool?.getConnectedCount() ?? 0,
  };
}

/**
 * ページのキャッシュリレーを取得する（未起動なら起動）。
 * **1 回の取得につき `release()` を必ず 1 回**呼ぶこと。
 *
 * @param config 採用されるのは最初の呼び出し側の設定だけ（{@link warnOnConflict}）
 */
export async function acquireRelayHost(config: RelayHostConfig = {}): Promise<RelayHost> {
  const resolved = resolveConfig(config);

  // 停止中のホストがグローバルを戻し終えるまで、次を起動しない。
  while (!current && pendingStop) {
    await pendingStop;
  }

  if (current) {
    warnOnConflict(current.config, resolved);
  } else {
    let stop: () => Promise<void> = async () => {};
    const promise = startHost(resolved).then((host) => {
      stop = () => host.relay.disconnect();
      return host;
    });
    current = {
      config: resolved,
      promise,
      refCount: 0,
      stop: () => stop(),
    };
  }

  const state = current;
  // await の前に同期で予約する。起動中に release() が来てもホストを畳ませないため。
  state.refCount += 1;

  let shared: SharedHost;
  try {
    shared = await state.promise;
  } catch (error) {
    state.refCount -= 1;
    if (state.refCount === 0 && current === state) {
      current = undefined;
    }
    throw error;
  }

  let released = false;
  return {
    ...shared,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      state.refCount -= 1;
      if (state.refCount > 0) {
        return;
      }
      if (current === state) {
        current = undefined;
      }
      // await する前に公開する。実行中に始まった `acquire()` が待つようにするため。
      const stopping = state.stop().finally(() => {
        if (pendingStop === stopping) {
          pendingStop = undefined;
        }
      });
      pendingStop = stopping;
      await stopping;
    },
  };
}

/** 未 `release()` の取得数。テストと、リレーの再起動を順序づけたい埋め込み側が使う。 */
export function getRelayHostRefCount(): number {
  return current?.refCount ?? 0;
}
