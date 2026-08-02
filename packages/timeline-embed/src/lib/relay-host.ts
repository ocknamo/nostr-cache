/**
 * Boots — and shares — the in-page cache relay that backs every
 * `<nostr-timeline>` on a page.
 *
 * Why a singleton: `WebSocketServerEmulator.start()` replaces
 * `globalThis.WebSocket`, keeping the previous value so `stop()` can restore
 * it. If two widgets each started their own emulator, the second would capture
 * the *already patched* constructor as its "original" and restoring them out of
 * order would leave the page with a dead WebSocket. One emulator per page also
 * avoids opening the same IndexedDB database twice and stops N widgets from
 * fanning N sets of upstream connections out to the same relays.
 *
 * Subscriptions are still isolated per widget: each one opens its own
 * `new WebSocket(interceptUrl)`, and the emulator tracks sockets in a
 * `Map<clientId, socket>`, so every widget gets its own client id and its own
 * REQ/CLOSE lifecycle. That is also why the widget talks NIP-01 over the
 * emulated socket rather than using the relay's in-process `subscribe()`, whose
 * `event` callback cannot say which subscription an event belongs to.
 */

import {
  DexieStorage,
  NostrCacheRelay,
  UpstreamRelayPool,
  WebSocketServerEmulator,
} from '@nostr-cache/cache-relay/browser';
import { CacheMetrics } from './cache-metrics.ts';
import { InstrumentedUpstreamPool } from './instrumented-upstream-pool.ts';

/**
 * Default URL served by the in-page relay. The RFC 6761 reserved `.invalid`
 * TLD can never resolve, so a connection that somehow escaped interception
 * fails instead of reaching a real server.
 */
export const DEFAULT_INTERCEPT_URL = 'ws://nostr-cache.invalid';
export const DEFAULT_DB_NAME = 'nostr-cache-embed';
/** Short enough that the ✓ badges appear while the user is still looking. */
export const DEFAULT_LAZY_VALIDATE_INTERVAL = 5;
/**
 * How long a cached kind 0 is trusted before the relay re-asks upstream.
 *
 * The widget re-opens its profile subscription whenever a new author scrolls
 * into view, which without a window would forward a REQ upstream every time —
 * for profiles it already holds. Deciding when a cached copy is stale enough to
 * re-check is the relay's job (`upstreamFreshness`), not the widget's, so the
 * widget simply asks for what it wants to display and lets the window suppress
 * the redundant upstream traffic.
 *
 * Five minutes comfortably covers a page view while still letting a profile
 * edit show up on a later visit.
 */
export const DEFAULT_PROFILE_FRESHNESS = 300;

export interface RelayHostConfig {
  /** Upstream relay URLs (`wss://…`). Empty means a cache-only relay. */
  upstreamRelays?: string[];
  /** IndexedDB database name. */
  dbName?: string;
  /** URL the emulator intercepts. */
  interceptUrl?: string;
  /** Seconds between background signature-validation passes. */
  lazyValidateInterval?: number;
  /** Seconds a cached profile (kind 0) is served without re-asking upstream. */
  profileFreshness?: number;
}

interface ResolvedConfig extends Required<RelayHostConfig> {}

export interface RelayHost {
  relay: NostrCacheRelay;
  storage: DexieStorage;
  metrics: CacheMetrics;
  /** URL to hand to `new WebSocket(...)`. */
  interceptUrl: string;
  /** Number of upstream relays currently connected (0 when cache-only). */
  getConnectedUpstreams(): number;
  /** Drop this acquisition. The relay is torn down when the last one releases. */
  release(): Promise<void>;
}

/** The parts shared by every acquisition of the same host. */
type SharedHost = Omit<RelayHost, 'release'>;

interface HostState {
  config: ResolvedConfig;
  promise: Promise<SharedHost>;
  refCount: number;
  stop: () => Promise<void>;
}

let current: HostState | undefined;
/**
 * Teardown of the previous host, while it is still in flight.
 *
 * A new host must not be started until this settles: `relay.disconnect()`
 * restores `globalThis.WebSocket`, and starting early would capture the still
 * patched constructor as the next host's "original".
 */
let pendingStop: Promise<void> | undefined;

function resolveConfig(config: RelayHostConfig): ResolvedConfig {
  return {
    upstreamRelays: config.upstreamRelays ?? [],
    dbName: config.dbName ?? DEFAULT_DB_NAME,
    interceptUrl: config.interceptUrl ?? DEFAULT_INTERCEPT_URL,
    lazyValidateInterval: config.lazyValidateInterval ?? DEFAULT_LAZY_VALIDATE_INTERVAL,
    profileFreshness: config.profileFreshness ?? DEFAULT_PROFILE_FRESHNESS,
  };
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
    // `relay.connect()` patches the global WebSocket before it can fail on
    // anything after that (validator, reaper, upstream). Leaving the patch in
    // place would hand the *next* host a patched constructor to keep as its
    // "original" — the exact breakage this module exists to prevent.
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
  // Only wire the upstream layer when there is somewhere to read through to;
  // otherwise the relay stays an independent cache-only relay.
  const upstreamPool = config.upstreamRelays.length
    ? new InstrumentedUpstreamPool(
        new UpstreamRelayPool(config.upstreamRelays, {
          // Resolve the constructor at connect time so upstream connections use
          // the pre-patch WebSocket and never loop back into the emulator.
          webSocketFactory: () => transport.getOriginalWebSocket?.() ?? globalThis.WebSocket,
        }),
        {
          onUpstreamEvent: (eventId, relayUrl) => metrics.recordUpstreamEvent(eventId, relayUrl),
        }
      )
    : undefined;

  const relay = new NostrCacheRelay(storage, transport, {
    // The relay verifies signatures in the background and persists the verdict,
    // so widgets render ✓ badges via getValidationStatus() without doing any
    // crypto of their own.
    validateEventsType: 'LAZY',
    lazyValidateInterval: config.lazyValidateInterval,
    maxSubscriptions: 20,
    upstreamPool,
    // Cache-first window for profiles: see DEFAULT_PROFILE_FRESHNESS. Kept here
    // rather than in the timeline code so the "when do we re-check upstream"
    // policy lives with the cache that answers it.
    upstreamFreshness: { 0: config.profileFreshness },
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
 * Get the page's cache relay, starting it if this is the first caller.
 *
 * Every call must be paired with exactly one `release()`; the relay shuts down
 * (restoring `globalThis.WebSocket`) when the last acquisition is released.
 *
 * @param config Relay settings. Honoured only by the first caller — see
 *   {@link warnOnConflict}.
 */
export async function acquireRelayHost(config: RelayHostConfig = {}): Promise<RelayHost> {
  const resolved = resolveConfig(config);

  // Let a host that is still shutting down finish restoring the global
  // WebSocket before starting a replacement on top of it.
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
      // Indirection so teardown works even if release() races the startup.
      stop: () => stop(),
    };
  }

  const state = current;
  // Reserve synchronously, before any await, so a release() that lands while
  // startup is still in flight cannot tear the host down underneath us.
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
      // Publish the teardown before awaiting it, so an `acquire()` that starts
      // while it is running waits rather than racing the global restore.
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

/**
 * How many un-released acquisitions the page currently holds.
 *
 * Useful in tests asserting that widgets clean up after themselves, and to an
 * embedder that needs to know when every widget has let go — the demo site uses
 * it to sequence a relay restart.
 */
export function getRelayHostRefCount(): number {
  return current?.refCount ?? 0;
}
