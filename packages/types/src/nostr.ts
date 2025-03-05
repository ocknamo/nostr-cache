/**
 * Nostr protocol type definitions
 */

/**
 * Nostr event as defined in NIP-01
 * https://github.com/nostr-protocol/nips/blob/master/01.md
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Nostr filter as defined in NIP-01
 */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

/**
 * Nostr subscription as defined in NIP-01
 */
export interface Subscription {
  id: string;
  filters: Filter[];
}
