import type { NostrCacheRelay, ValidationStatus } from '@nostr-cache/cache-relay/browser';

export type { ValidationStatus };

/**
 * Fetch the persisted validation statuses for the given event ids straight
 * from the local relay (direct method call — no emulated WebSocket round
 * trip). The relay verified the signatures (immediately or lazily), so the
 * client can render verification badges without re-verifying anything.
 *
 * @param relay The in-page local relay
 * @param ids Event IDs to look up (deduplicated here)
 * @returns Map with one entry per id
 */
export async function fetchValidationStatuses(
  relay: NostrCacheRelay,
  ids: string[]
): Promise<Map<string, ValidationStatus>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  return relay.getValidationStatus(unique);
}

/**
 * Whether any status is still `pending` — i.e. a later lazy-validation pass
 * may flip it to `validated`, so a refetch is worthwhile. `unknown` is
 * terminal (never stored, deleted as invalid, or evicted) and must NOT keep
 * polling alive: nothing can turn it into `validated`.
 */
export function hasPending(statuses: Map<string, ValidationStatus>): boolean {
  for (const status of statuses.values()) {
    if (status === 'pending') {
      return true;
    }
  }
  return false;
}
