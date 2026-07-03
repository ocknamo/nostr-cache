import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { insertEvent } from './timeline-utils.ts';

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
