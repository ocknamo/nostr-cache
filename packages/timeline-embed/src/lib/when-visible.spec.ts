// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenVisible, whileVisible } from './when-visible.ts';

/**
 * A stand-in `IntersectionObserver` whose callback can be fired by hand, so a
 * spec can say when the element crosses the viewport — jsdom never lays
 * anything out, so nothing ever intersects on its own.
 */
function stubObserver() {
  const instances: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
  class Stub {
    disconnected = false;
    constructor(readonly callback: IntersectionObserverCallback) {
      instances.push(this);
    }
    observe(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
  }
  vi.stubGlobal('IntersectionObserver', Stub);

  return {
    /** Deliver one entry to the observer created last. */
    report(isIntersecting: boolean): void {
      const current = instances[instances.length - 1];
      current.callback([{ isIntersecting } as IntersectionObserverEntry], {} as never);
    },
    get last() {
      return instances[instances.length - 1];
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whileVisible', () => {
  it('reports each crossing, unlike whenVisible which reports one', () => {
    const observer = stubObserver();
    const seen: boolean[] = [];
    whileVisible(document.createElement('div'), (visible) => seen.push(visible));

    observer.report(true);
    observer.report(false);
    observer.report(true);

    expect(seen).toEqual([true, false, true]);
  });

  it('keeps watching after a crossing, where whenVisible disconnects', () => {
    const observer = stubObserver();
    const node = document.createElement('div');

    whenVisible(node, () => {});
    observer.report(true);
    expect(observer.last.disconnected).toBe(true);

    whileVisible(node, () => {});
    observer.report(true);
    expect(observer.last.disconnected).toBe(false);
  });

  it('reports to the callback swapped in by a re-render', () => {
    const observer = stubObserver();
    const action = whileVisible(document.createElement('div'), () => {});
    const next = vi.fn();

    action.update(next);
    observer.report(true);

    expect(next).toHaveBeenCalledWith(true);
  });

  it('disconnects on destroy', () => {
    const observer = stubObserver();
    const action = whileVisible(document.createElement('div'), () => {});

    action.destroy();

    expect(observer.last.disconnected).toBe(true);
  });

  it('reports nothing at all without an IntersectionObserver', () => {
    // The opposite of `whenVisible`'s fallback, and deliberately: an eager
    // author lookup is a good failure, a timeline paging itself is not.
    vi.stubGlobal('IntersectionObserver', undefined);
    const callback = vi.fn();

    const action = whileVisible(document.createElement('div'), callback);
    action.update(callback);
    action.destroy();

    expect(callback).not.toHaveBeenCalled();
  });
});
