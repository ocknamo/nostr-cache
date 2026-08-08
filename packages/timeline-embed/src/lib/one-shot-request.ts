/**
 * Pick the version of a replaceable event NIP-01 says to keep.
 *
 * The fetching itself is `RelayConnection.fetchOnce`, which is rx-nostr's
 * oneshot strategy: it completes on EOSE, carries its own timeout and closes
 * the subscription on every path. What is left here is the one thing rx-nostr
 * gets differently — the version ordering.
 *
 * Its `latest()` operator looks like a drop-in, but `compareEvents` breaks a
 * `created_at` tie by keeping the **highest** id (the code cites the older
 * NIP-16), while NIP-01 and this repository's storage keep the **lowest**.
 * Borrowing it would have the widget display a different version from the one
 * the relay stores, so the comparison stays ours — `supersedes`, the same
 * predicate both storage adapters resolve a coordinate with.
 */

import { supersedes } from '@nostr-cache/cache-relay/browser';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { RelayConnection } from './relay-connection.ts';

/**
 * Reduce delivered versions of one replaceable coordinate to the current one.
 *
 * @param events Versions as they arrived — two upstream relays can each answer
 *   with their own copy, in either order
 */
export function latestReplaceable(events: NostrEvent[]): NostrEvent | undefined {
  let current: NostrEvent | undefined;
  for (const event of events) {
    if (!current || supersedes(event, current)) {
      current = event;
    }
  }
  return current;
}

/**
 * Fetch the current version of one replaceable event.
 *
 * @returns The event, or `undefined` when none arrived — which covers "not
 *   published", "not upstream" and "the relay never answered" alike, because
 *   none of them is distinguishable from here
 */
export async function fetchLatestReplaceable(
  connection: RelayConnection,
  filter: Filter,
  options: { signal?: AbortSignal } = {}
): Promise<NostrEvent | undefined> {
  return latestReplaceable(await connection.fetchOnce([filter], options));
}
