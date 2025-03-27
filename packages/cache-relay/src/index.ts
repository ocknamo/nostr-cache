/**
 * Nostr Cache Relay
 *
 * Provides a Nostr relay implementation with caching functionality.
 */

import { MessageHandler } from './core/message-handler.js';
// Core components
import { NostrCacheRelay, NostrRelayOptions } from './core/nostr-cache-relay.js';
import { SubscriptionManager } from './core/subscription-manager.js';

// Event handling
import { EventHandler } from './event/event-handler.js';
import { EventValidator } from './event/event-validator.js';

import { DexieStorage } from './storage/dexie-storage.js';
// Storage
import { StorageAdapter } from './storage/storage-adapter.js';

// Transport
import { TransportAdapter } from './transport/transport-adapter.js';
import { WebSocketServerEmulator } from './transport/web-socket-server-emulator.js';
import { WebSocketServer } from './transport/web-socket-server.js';

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
  DexieStorage,
  // Transport
  TransportAdapter,
  WebSocketServer,
  WebSocketServerEmulator,
  // Utils
  filterUtils,
};
