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

/** What an upstream answer has delivered: how many, and how far back. */
export interface UpstreamAnswer {
  count: number;
  /** Undefined until the first event. */
  oldest?: number;
}

/**
 * The most events an answer to these filters can hold without one of them
 * having been cut off; undefined when a filter has no limit to be cut off at.
 *
 * Their sum, because the filters travel as one REQ and come back as one stream:
 * a count cannot be attributed to the filter that earned it, and only the sum
 * makes "as many as this" imply that some filter reached its own limit.
 */
export function requestLimit(filters: Filter[]): number | undefined {
  let limit: number | undefined;
  for (const filter of filters) {
    if (filter.limit === undefined) {
      return undefined;
    }
    limit = (limit ?? 0) + filter.limit;
  }
  return limit;
}

/**
 * How far back an upstream answer vouches for the timeline being whole: an
 * answer long enough to have been cut off sent nothing below its oldest event,
 * so what the cache has further down can be separated from it by a hole.
 *
 * @returns that oldest `created_at`, or undefined when the answer was short
 *   enough to be everything upstream had — including the empty answer a
 *   cache-only relay gives
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
