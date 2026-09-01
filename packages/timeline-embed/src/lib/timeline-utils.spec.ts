import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { coverageFloor, insertEvent, requestLimit, trimOlderThan } from './timeline-utils.ts';

function event(id: string, createdAt: number): NostrEvent {
  return {
    id,
    pubkey: 'pub',
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: id,
    sig: 'sig',
  };
}

describe('insertEvent', () => {
  it('keeps the timeline sorted newest-first', () => {
    let timeline: NostrEvent[] = [];
    timeline = insertEvent(timeline, event('a', 100));
    timeline = insertEvent(timeline, event('b', 300));
    timeline = insertEvent(timeline, event('c', 200));

    expect(timeline.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('drops duplicate IDs and returns the original array', () => {
    const timeline = insertEvent([], event('a', 100));
    const next = insertEvent(timeline, event('a', 999));
    expect(next).toBe(timeline);
    expect(next).toHaveLength(1);
  });

  it('keeps insertion order for equal timestamps', () => {
    let timeline: NostrEvent[] = [];
    timeline = insertEvent(timeline, event('first', 100));
    timeline = insertEvent(timeline, event('second', 100));
    expect(timeline.map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('caps the timeline size by dropping the oldest events', () => {
    let timeline: NostrEvent[] = [];
    for (let i = 0; i < 5; i++) {
      timeline = insertEvent(timeline, event(`e${i}`, i), 3);
    }
    expect(timeline).toHaveLength(3);
    expect(timeline.map((e) => e.created_at)).toEqual([4, 3, 2]);
  });

  it('does not mutate the input array', () => {
    const original = insertEvent([], event('a', 100));
    const snapshot = [...original];
    insertEvent(original, event('b', 200));
    expect(original).toEqual(snapshot);
  });
});

describe('requestLimit', () => {
  it('takes the largest limit the filters ask for', () => {
    expect(
      requestLimit([
        { kinds: [1], limit: 20 },
        { kinds: [6], limit: 50 },
      ])
    ).toBe(50);
  });

  it('reports none when a filter has no limit of its own', () => {
    // Its answer is bounded by the relay's own ceiling, which says nothing
    // about whether it was cut off.
    expect(requestLimit([{ kinds: [1], limit: 20 }, { kinds: [6] }])).toBeUndefined();
    expect(requestLimit([])).toBeUndefined();
  });
});

describe('coverageFloor', () => {
  it('reports the oldest event of an answer that hit the limit', () => {
    expect(coverageFloor({ count: 50, oldest: 1_700_000_000 }, 50)).toBe(1_700_000_000);
  });

  it('vouches all the way down when the answer came back short', () => {
    expect(coverageFloor({ count: 49, oldest: 1_700_000_000 }, 50)).toBeUndefined();
  });

  it('vouches all the way down when nothing came from upstream', () => {
    // What a cache-only relay produces on every REQ.
    expect(coverageFloor({ count: 0 }, 50)).toBeUndefined();
  });

  it('reports nothing without a limit to have been cut off at', () => {
    expect(coverageFloor({ count: 500, oldest: 1_700_000_000 }, undefined)).toBeUndefined();
  });
});

describe('trimOlderThan', () => {
  it('drops what is older than the floor and keeps what sits on it', () => {
    const timeline = [event('a', 300), event('b', 200), event('c', 100)];

    expect(trimOlderThan(timeline, 200).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('returns the original array when nothing is older', () => {
    const timeline = [event('a', 300), event('b', 200)];

    expect(trimOlderThan(timeline, 200)).toBe(timeline);
  });
});
