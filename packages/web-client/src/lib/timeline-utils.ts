import type { NostrEvent } from '@nostr-cache/shared';

export const DEFAULT_TIMELINE_CAP = 500;

/**
 * Insert an event into a newest-first timeline.
 *
 * - Duplicate IDs are dropped (the original array is returned unchanged).
 * - Ordering is by created_at descending; equal timestamps keep insertion
 *   order (new event goes after existing ones with the same created_at).
 * - The result is capped at maxSize entries (oldest dropped).
 *
 * Returns a new array (never mutates the input) so it plays well with
 * reactive UI state.
 */
export function insertEvent(
  events: NostrEvent[],
  event: NostrEvent,
  maxSize = DEFAULT_TIMELINE_CAP
): NostrEvent[] {
  if (events.some((existing) => existing.id === event.id)) {
    return events;
  }

  let insertAt = events.length;
  for (let i = 0; i < events.length; i++) {
    if (events[i].created_at < event.created_at) {
      insertAt = i;
      break;
    }
  }

  const next = [...events.slice(0, insertAt), event, ...events.slice(insertAt)];
  return next.length > maxSize ? next.slice(0, maxSize) : next;
}
