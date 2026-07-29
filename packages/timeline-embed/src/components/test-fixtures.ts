import type { NostrEvent } from '@nostr-cache/shared';

/**
 * Build a NostrEvent for component tests. Override any field via `overrides`.
 */
export function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'id0000000000000000000000000000000000000000000000000000000000000',
    pubkey: 'pk0000000000000000000000000000000000000000000000000000000000000',
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hello world',
    sig: 'sig0',
    ...overrides,
  };
}
