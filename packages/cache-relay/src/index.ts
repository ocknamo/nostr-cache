/**
 * Nostr Cache Relay
 *
 * Provides a Nostr relay implementation with caching functionality.
 */

import { MessageHandler } from './core/message-handler.js';
// Core components
import { NostrCacheRelay, NostrRelayOptions } from './core/nostr-cache-relay.js';
// cachePriority 設定の正規化（npub→hex・検証）。setCachePriority へ渡す前の
// 事前検証に利用できる
import { normalizeCachePriority, normalizeFreshnessWindows } from './core/relay-options.js';
import { SubscriptionManager } from './core/subscription-manager.js';

// Event handling
// 座標の d 識別子判定。Dexie 非依存の純関数で、SQLite アダプタが NIP-09 の
// `a` タグ解釈を単一ソース化するために再利用する
import { isDeletableAddress, matchesAddressIdentifier } from './event/deletion.js';
import { EventHandler } from './event/event-handler.js';
// NIP-01 の kind レンジ判定。SQLite アダプタが NIP-09 のガード条件を
// cache-relay と同じ定義で書くために必要なものだけを公開する
import { DELETION_EVENT_KIND } from './event/event-kind.js';
import { EventValidator } from './event/event-validator.js';
// NIP-01 の置換可能イベントの版比較（最新の1件だけを保持する）。これも Dexie 非依存の
// 純関数で、SQLite アダプタが `getCurrentVersion` を同じ順序規則で実装するために共有する
import { addressOf, selectCurrentVersion, supersedes } from './event/replaceable.js';

import { DexieStorage } from './storage/dexie-storage.js';
// タグの平坦化（"k:v" 形式・100 件上限・優先タグソート）。Dexie 非依存の純関数で、
// server パッケージの SQLite アダプタがタグインデックスのセマンティクスを
// 単一ソース化するために再利用する
import { getIndexedTags } from './storage/dexie/tag-index.js';
// キャッシュ保持優先度の判定。こちらも Dexie 非依存の純関数で SQLite アダプタと共有する
import {
  type CachePriority,
  createPriorityMatcher,
  getAlwaysRetainedKinds,
  hasPriorityRules,
} from './storage/priority.js';
// Storage
import {
  CacheStrategy,
  EventAddress,
  SaveEventOptions,
  StorageAdapter,
  ValidationStatus,
} from './storage/storage-adapter.js';

// Transport
import { TransportAdapter } from './transport/transport-adapter.js';
import { WebSocketServerEmulator } from './transport/web-socket-server-emulator.js';
import { WebSocketServer } from './transport/web-socket-server.js';

// Upstream (read-through / write-through)
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
  // Deletion requests (NIP-09) — storage adapters implement the spec's
  // "same pubkey only" / "never delete a kind 5" guards themselves
  DELETION_EVENT_KIND,
  isDeletableAddress,
  matchesAddressIdentifier,
  // Replaceable / addressable version comparison (NIP-01) — storage adapters
  // resolve "the current version of a coordinate" with the same ordering
  addressOf,
  selectCurrentVersion,
  supersedes,
  // Storage
  StorageAdapter,
  CacheStrategy,
  EventAddress,
  SaveEventOptions,
  ValidationStatus,
  DexieStorage,
  getIndexedTags,
  type CachePriority,
  createPriorityMatcher,
  hasPriorityRules,
  getAlwaysRetainedKinds,
  normalizeCachePriority,
  normalizeFreshnessWindows,
  // Transport
  TransportAdapter,
  WebSocketServer,
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
