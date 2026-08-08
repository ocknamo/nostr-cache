/** Relay-related constants */

export const DEFAULT_RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.info',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.current.fyi',
  'wss://nos.lol',
];

/** ミリ秒 */
export const DEFAULT_SUBSCRIPTION_TIMEOUT = 3000;

/** ミリ秒 */
export const DEFAULT_REQUEST_TIMEOUT = 10000;

/** Default maximum number of relays to connect to simultaneously */
export const DEFAULT_MAX_CONCURRENT_RELAYS = 5;
