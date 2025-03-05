/**
 * Relay-related constants
 */

/**
 * Default Nostr relay URLs
 */
export const DEFAULT_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.info',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.current.fyi',
  'wss://nos.lol'
];

/**
 * Default connection timeout in milliseconds
 */
export const DEFAULT_CONNECTION_TIMEOUT = 5000;

/**
 * Default subscription timeout in milliseconds
 */
export const DEFAULT_SUBSCRIPTION_TIMEOUT = 3000;

/**
 * Default request timeout in milliseconds
 */
export const DEFAULT_REQUEST_TIMEOUT = 10000;

/**
 * Default maximum number of relays to connect to simultaneously
 */
export const DEFAULT_MAX_CONCURRENT_RELAYS = 5;
