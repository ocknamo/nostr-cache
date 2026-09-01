import type { Filter, NostrEvent } from '@nostr-cache/shared';

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

/**
 * What an upstream answer has delivered so far: how many events, and how far
 * back they reach.
 */
export interface UpstreamAnswer {
  count: number;
  /** Oldest `created_at` delivered; undefined until the first event. */
  oldest?: number;
}

/**
 * The count an answer to these filters is cut off at, or undefined when there
 * is nothing to compare a count against.
 *
 * The largest of the limits rather than their sum: the filters travel as one
 * REQ and are answered as one stream, so a count cannot be attributed to the
 * filter that earned it.
 */
export function requestLimit(filters: Filter[]): number | undefined {
  let limit: number | undefined;
  for (const filter of filters) {
    if (filter.limit === undefined) {
      return undefined;
    }
    limit = limit === undefined ? filter.limit : Math.max(limit, filter.limit);
  }
  return limit;
}

/**
 * How far back an upstream answer vouches for the timeline being whole.
 *
 * An answer as long as the REQ's `limit` was cut off there: upstream holds more
 * below its oldest event and did not send it, so anything the cache has further
 * down may be separated from it by a hole. A shorter answer is everything
 * upstream had, and leaves nothing to be missing — as does an answer with no
 * events in it at all, which is what a cache-only relay always produces.
 *
 * @returns the oldest `created_at` upstream delivered, below which nothing is
 *   vouched for; undefined when the answer proves nothing is missing
 */
export function coverageFloor(
  answer: UpstreamAnswer,
  limit: number | undefined
): number | undefined {
  if (limit === undefined || answer.oldest === undefined || answer.count < limit) {
    return undefined;
  }
  return answer.oldest;
}

/** Drop everything older than `floor`; the same array back when nothing is. */
export function trimOlderThan(events: NostrEvent[], floor: number): NostrEvent[] {
  const kept = events.filter((event) => event.created_at >= floor);
  return kept.length === events.length ? events : kept;
}
