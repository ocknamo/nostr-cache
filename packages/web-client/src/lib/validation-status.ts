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
 * Whether any status is still undecided (`pending` or `unknown`) — i.e. a
 * later refetch may change the display. Used to keep polling only while a
 * lazy validation pass could still flip something to `validated`.
 */
export function hasUndecided(statuses: Map<string, ValidationStatus>): boolean {
  for (const status of statuses.values()) {
    if (status !== 'validated') {
      return true;
    }
  }
  return false;
}
