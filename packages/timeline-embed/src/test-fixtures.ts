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
 * `makeEvent` の署名はでたらめなので、未検証のまま入れると遅延検証のパス
 * （リレー起動時と 5 秒ごと）が消しにかかる。単体では通るのにスイートが混むと
 * パスが assert の途中に降ってきて落ちる、という形で表面化する。
 */
export async function seedValidated(
  storage: Pick<StorageAdapter, 'saveEvent'>,
  events: NostrEvent[]
): Promise<void> {
  for (const event of events) {
    await storage.saveEvent(event, { validated: true });
  }
}
