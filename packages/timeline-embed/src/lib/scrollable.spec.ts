// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { hasScrollableAncestor } from './scrollable.ts';

/**
 * jsdom lays nothing out, so every box measures zero. The sizes are stubbed per
 * element, which is the whole of what this predicate reads besides `overflow`.
 */
function stubSize(element: Element, { scrollHeight = 0, clientHeight = 0 } = {}): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('hasScrollableAncestor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    stubSize(document.documentElement);
  });

  it('reports a page whose content is taller than the viewport', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    stubSize(document.documentElement, { scrollHeight: 2000, clientHeight: 800 });

    expect(hasScrollableAncestor(node)).toBe(true);
  });

  it('ignores a page that has locked its own scrolling', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    document.documentElement.style.overflowY = 'hidden';
    stubSize(document.documentElement, { scrollHeight: 2000, clientHeight: 800 });

    try {
      expect(hasScrollableAncestor(node)).toBe(false);
    } finally {
      document.documentElement.style.overflowY = '';
    }
  });

  it('reports nothing scrollable when every box fits its content', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);

    expect(hasScrollableAncestor(node)).toBe(false);
  });

  it('reports an ancestor that overflows and is allowed to scroll', () => {
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    const node = document.createElement('div');
    box.appendChild(node);
    document.body.appendChild(box);
    stubSize(box, { scrollHeight: 2000, clientHeight: 400 });

    expect(hasScrollableAncestor(node)).toBe(true);
  });

  it('ignores an ancestor that overflows with the content simply spilling out', () => {
    const box = document.createElement('div');
    box.style.overflowY = 'visible';
    const node = document.createElement('div');
    box.appendChild(node);
    document.body.appendChild(box);
    stubSize(box, { scrollHeight: 2000, clientHeight: 400 });

    expect(hasScrollableAncestor(node)).toBe(false);
  });

  it('crosses the shadow boundary the widget renders inside', () => {
    const host = document.createElement('div');
    const box = document.createElement('div');
    box.style.overflowY = 'scroll';
    box.appendChild(host);
    document.body.appendChild(box);
    stubSize(box, { scrollHeight: 2000, clientHeight: 400 });

    const node = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(node);

    expect(hasScrollableAncestor(node)).toBe(true);
  });

  it('says no for a node that is not in a document at all', () => {
    expect(hasScrollableAncestor(document.createElement('div'))).toBe(false);
  });
});
