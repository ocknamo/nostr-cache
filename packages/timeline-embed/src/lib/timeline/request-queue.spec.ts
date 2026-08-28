import { describe, expect, it } from 'vitest';
import { RequestQueue } from './request-queue.ts';

/** The rules every lookup in `timeline/` inherits. */
describe('RequestQueue', () => {
  function createQueue(canStart: () => boolean = () => true): {
    queue: RequestQueue<string>;
    started: string[];
  } {
    const started: string[] = [];
    const queue = new RequestQueue<string>({
      key: (item) => item,
      canStart,
      hasCapacity: () => true,
      start: (item) => started.push(item),
    });
    return { queue, started };
  }

  it('starts an accepted item straight away', () => {
    const { queue, started } = createQueue();

    expect(queue.request('alice')).toBe(true);
    expect(started).toEqual(['alice']);
  });

  it('ignores a repeat of a key it has already accepted', () => {
    const { queue, started } = createQueue();
    queue.request('alice');

    expect(queue.request('alice')).toBe(false);
    expect(started).toEqual(['alice']);
  });

  it('holds items back while nothing may start, then drains in order', () => {
    let connected = false;
    const { queue, started } = createQueue(() => connected);
    queue.request('alice');
    queue.request('bob');

    expect(started).toEqual([]);

    connected = true;
    queue.pump();

    expect(started).toEqual(['alice', 'bob']);
  });

  it('starts only as many as the budget allows, and the rest when it frees up', () => {
    // A start takes a slot, as an in-flight subscription does.
    let inFlight = 0;
    const started: string[] = [];
    const queue = new RequestQueue<string>({
      key: (item) => item,
      canStart: () => true,
      hasCapacity: () => inFlight < 2,
      start: (item) => {
        inFlight += 1;
        started.push(item);
      },
    });
    for (const name of ['alice', 'bob', 'carol']) {
      queue.request(name);
    }

    expect(started).toEqual(['alice', 'bob']);

    inFlight = 0;
    queue.pump();

    expect(started).toEqual(['alice', 'bob', 'carol']);
  });

  it('lets a released key be asked for again', () => {
    const { queue, started } = createQueue();
    queue.request('alice');

    queue.release('alice');

    expect(queue.request('alice')).toBe(true);
    expect(started).toEqual(['alice', 'alice']);
  });

  it('drops what is queued on clear, but still de-duplicates', () => {
    let connected = false;
    const { queue, started } = createQueue(() => connected);
    queue.request('alice');

    queue.clear();
    connected = true;
    queue.pump();

    expect(started).toEqual([]);
    // clear() is not an invitation to retry.
    expect(queue.request('alice')).toBe(false);
  });

  it('drops what is queued on reset, and lets every key be asked for again', () => {
    let connected = false;
    const { queue, started } = createQueue(() => connected);
    queue.request('alice');

    queue.reset();
    connected = true;
    queue.pump();

    expect(started).toEqual([]);
    expect(queue.request('alice')).toBe(true);
    expect(started).toEqual(['alice']);
  });
});
