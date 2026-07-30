/**
 * Nostr Cache Relay — browser entry point
 *
 * Same public API as the main entry point except for the Node.js-only
 * `WebSocketServer` (which depends on `ws` and `node:crypto` and cannot be
 * bundled for the browser). Browser apps should import from
 * `@nostr-cache/cache-relay/browser`.
 */

import { MessageHandler } from './core/message-handler.js';
// Core components
import { NostrCacheRelay, NostrRelayOptions } from './core/nostr-cache-relay.js';
// cachePriority 設定の正規化（npub→hex・検証）。setCachePriority へ渡す前の
// 事前検証に利用できる
import { normalizeCachePriority, normalizeFreshnessWindows } from './core/relay-options.js';
import { SubscriptionManager } from './core/subscription-manager.js';

// Event handling
import { EventHandler } from './event/event-handler.js';
import { EventValidator } from './event/event-validator.js';

import { DexieStorage } from './storage/dexie-storage.js';
// キャッシュ優先度の判定（Dexie 非依存の純関数）
import { type CachePriority, createPriorityMatcher, hasPriorityRules } from './storage/priority.js';
// Storage
import {
  CacheStrategy,
  SaveEventOptions,
  StorageAdapter,
  ValidationStatus,
} from './storage/storage-adapter.js';

// Transport
import { TransportAdapter } from './transport/transport-adapter.js';
import { WebSocketServerEmulator } from './transport/web-socket-server-emulator.js';

// Upstream (read-through / write-through) — isomorphic, no `ws` dependency
import {
  FreshnessGate,
  type FreshnessWindows,
  isFreshnessEligible,
  narrowFiltersByFreshness,
} from './upstream/freshness.js';
import { UpstreamConnection } from './upstream/upstream-connection.js';
import { UpstreamCoordinator } from './upstream/upstream-coordinator.js';
import { UpstreamRelayPool } from './upstream/upstream-relay-pool.js';
import type { UpstreamPool, UpstreamPoolOptions } from './upstream/upstream-types.js';

// Utils
import * as filterUtils from './utils/filter-utils.js';

export {
  // Core
  NostrCacheRelay,
  NostrRelayOptions,
  MessageHandler,
  SubscriptionManager,
  // Event
  EventHandler,
  EventValidator,
  // Storage
  StorageAdapter,
  CacheStrategy,
  SaveEventOptions,
  ValidationStatus,
  DexieStorage,
  type CachePriority,
  createPriorityMatcher,
  hasPriorityRules,
  normalizeCachePriority,
  normalizeFreshnessWindows,
  // Transport
  TransportAdapter,
  WebSocketServerEmulator,
  // Upstream
  UpstreamRelayPool,
  UpstreamConnection,
  UpstreamCoordinator,
  type UpstreamPool,
  type UpstreamPoolOptions,
  // Freshness window (cache-first read-through)
  FreshnessGate,
  type FreshnessWindows,
  isFreshnessEligible,
  narrowFiltersByFreshness,
  // Utils
  filterUtils,
};
