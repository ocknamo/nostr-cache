/** Shared types and utilities for Nostr cache project */

// Export constants
export * from './constants/relays.js';

// Export utilities
export { logger, LogLevel } from './utils/logger.js';
export { getRandomSecret } from './utils/crypto.js';
export { npubToHex, normalizePubkey, decodeNip19, NIP19_PREFIXES } from './utils/nip19.js';
export type {
  Nip19Address,
  Nip19Entity,
  Nip19Event,
  Nip19Prefix,
  Nip19Profile,
} from './utils/nip19.js';
export { messageToWire } from './utils/message-to-wire.js';

// Export all types
export * from './types/nostr.js';
export * from './types/message.js';
