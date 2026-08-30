/**
 * Whether anything between the node and the viewport can actually scroll.
 *
 * A box that cannot scroll hides nothing below the fold, so the paging sentinel
 * being on screen inside one says only that it always was — which is what an
 * iframe sized to its content by the embedding page (`embed-host.js`) leaves.
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
  const overflow = view.getComputedStyle(element).overflowY;
  // The root does not have to opt in — it scrolls unless it is stopped, which
  // is how a page locks scrolling behind a modal.
  if (element === element.ownerDocument.documentElement) {
    return overflow !== 'hidden' && overflow !== 'clip';
  }
  return overflow === 'auto' || overflow === 'scroll';
}
