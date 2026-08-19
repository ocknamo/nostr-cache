import type { StorageAdapter } from '@nostr-cache/cache-relay/browser';
import type { NostrEvent } from '@nostr-cache/shared';

/** Build a NostrEvent for component tests. Override any field via `overrides`. */
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

/**
 * Put fixture events into a relay's cache as signature-verified.
 *
 * `makeEvent` の署名はでたらめなので、未検証のまま入れると遅延検証のパス
 * （リレー起動時と一定間隔）がこれらを消しにかかり、読み出しとの競争になる。
 */
export async function seedValidated(
  storage: Pick<StorageAdapter, 'saveEvent'>,
  events: NostrEvent[]
): Promise<void> {
  for (const event of events) {
    await storage.saveEvent(event, { validated: true });
  }
}
