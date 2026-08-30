/**
 * Whether anything between the node and the viewport can actually scroll.
 *
 * The paging sentinel is driven by `IntersectionObserver`, which reports an
 * element on screen whether or not the reader could ever have scrolled to it.
 * That difference matters for the iframe host page: it reports its height to the
 * embedding page (`embed-host.js`), and a parent that sizes the frame to its
 * content leaves the document with no scroll at all — so the sentinel sits
 * permanently in view and every page would load itself unprompted. A box that
 * cannot scroll is hiding nothing below the fold, which is the same reason a
 * short embedding page should not page either.
 *
 * @param node Element to walk up from; shadow boundaries are crossed, since the
 *   widget renders inside one
 */
export function hasScrollableAncestor(node: Element): boolean {
  const view = node.ownerDocument.defaultView;
  if (!view) {
    return false;
  }
  for (let current = ancestorOf(node); current; current = ancestorOf(current)) {
    if (scrolls(current, view)) {
      return true;
    }
  }
  return false;
}

/** The parent element, stepping out of a shadow root onto its host. */
function ancestorOf(node: Element): Element | null {
  return node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
}

function scrolls(element: Element, view: Window): boolean {
  if (element.scrollHeight - element.clientHeight <= 1) {
    return false;
  }
  // The root scroller has no `overflow` to opt in with: it scrolls whenever its
  // content is taller than the viewport.
  if (element === element.ownerDocument.documentElement) {
    return true;
  }
  const overflow = view.getComputedStyle(element).overflowY;
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}
