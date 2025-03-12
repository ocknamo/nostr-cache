/**
 * Nostr Cache Relay
 *
 * Provides a Nostr relay implementation with caching functionality.
 */

import { MessageHandler } from './core/MessageHandler';
// Core components
import { NostrCacheRelay, NostrRelayOptions } from './core/NostrCacheRelay';
import { SubscriptionManager } from './core/SubscriptionManager';

// Event handling
import { EventHandler } from './event/EventHandler';
import { EventValidator } from './event/EventValidator';

// Storage
import { StorageAdapter } from './storage/StorageAdapter';

// Transport
import { TransportAdapter } from './transport/TransportAdapter';

// Utils
import * as filterUtils from './utils/filterUtils';

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
  // Transport
  TransportAdapter,
  // Utils
  filterUtils,
};
