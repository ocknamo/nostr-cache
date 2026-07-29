import { describe, expect, it } from 'vitest';
import { RequestTimer } from './request-timer.ts';

/** Deterministic clock: each read advances by one millisecond unless set. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
}

describe('RequestTimer', () => {
  it('measures time to first event and to EOSE', () => {
    const clock = fakeClock();
    const timer = new RequestTimer(clock.now);

    clock.set(100);
    timer.start('sub');
    clock.set(140);
    timer.markEvent('sub');
    clock.set(180);
    timer.markEose('sub');

    expect(timer.durations('sub')).toEqual({
      timeToFirstEvent: 40,
      timeToEose: 80,
      eventCount: 1,
    });
  });

  it('keeps the first event time while counting every event', () => {
    const clock = fakeClock();
    const timer = new RequestTimer(clock.now);

    timer.start('sub');
    clock.set(10);
    timer.markEvent('sub');
    clock.set(50);
    timer.markEvent('sub');

    const durations = timer.durations('sub');
    expect(durations?.timeToFirstEvent).toBe(10);
    expect(durations?.eventCount).toBe(2);
  });

  it('ignores a second EOSE', () => {
    const clock = fakeClock();
    const timer = new RequestTimer(clock.now);

    timer.start('sub');
    clock.set(30);
    timer.markEose('sub');
    clock.set(900);
    timer.markEose('sub');

    expect(timer.durations('sub')?.timeToEose).toBe(30);
  });

  it('leaves durations undefined until the corresponding signal arrives', () => {
    const timer = new RequestTimer(fakeClock().now);
    timer.start('sub');

    expect(timer.durations('sub')).toEqual({
      timeToFirstEvent: undefined,
      timeToEose: undefined,
      eventCount: 0,
    });
    expect(timer.isComplete('sub')).toBe(false);
  });

  it('reports completion only after EOSE', () => {
    const timer = new RequestTimer(fakeClock().now);
    timer.start('sub');
    timer.markEvent('sub');
    expect(timer.isComplete('sub')).toBe(false);

    timer.markEose('sub');
    expect(timer.isComplete('sub')).toBe(true);
  });

  it('ignores marks for a key that was never started', () => {
    const timer = new RequestTimer(fakeClock().now);

    timer.markEvent('ghost');
    timer.markEose('ghost');

    expect(timer.durations('ghost')).toBeUndefined();
  });

  it('restarts the clock when a key is reused', () => {
    const clock = fakeClock();
    const timer = new RequestTimer(clock.now);

    timer.start('sub');
    clock.set(50);
    timer.markEvent('sub');

    clock.set(200);
    timer.start('sub');
    clock.set(210);
    timer.markEvent('sub');

    expect(timer.durations('sub')).toEqual({
      timeToFirstEvent: 10,
      timeToEose: undefined,
      eventCount: 1,
    });
  });
});
