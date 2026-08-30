/**
 * Report the element's first appearance on screen, then stop watching.
 *
 * Everything the widget fetches beyond the timeline itself — an author's kind 0,
 * a quoted event — hangs off this: a timeline can hold 500 events, and looking
 * all of them up on first paint would cost the embedding page a burst of
 * requests for cards nobody scrolled to.
 *
 * Falls back to reporting immediately where `IntersectionObserver` is missing
 * (jsdom, older browsers): the lookup being eager is a far better failure than
 * every author staying an anonymous pubkey.
 */
export function whenVisible(node: HTMLElement, callback?: () => void) {
  // Read through a mutable holder so `update` can swap the callback in: an
  // action captures its argument once, and the prop is optional, so an element
  // that gains a callback later would otherwise never report.
  let current = callback;
  let reported = false;

  const report = () => {
    if (reported || !current) {
      return;
    }
    reported = true;
    current();
  };

  if (typeof IntersectionObserver === 'undefined') {
    report();
    return {
      update: (next?: () => void) => {
        current = next;
        report();
      },
      destroy: () => {},
    };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        report();
      }
    },
    // Start the lookup just before the element arrives, so what it fetches is
    // usually there by the time it is read rather than popping in afterwards.
    { rootMargin: '200px' }
  );
  observer.observe(node);
  return {
    update: (next?: () => void) => {
      current = next;
    },
    destroy: () => observer.disconnect(),
  };
}

/**
 * Report whether the element is on screen, every time that changes.
 *
 * The paging sentinel it watches moves down the page as older events are
 * appended, so it has to report each time it comes back — which is exactly what
 * {@link whenVisible} disconnects to avoid.
 *
 * Where `IntersectionObserver` is missing this reports nothing at all, rather
 * than taking that one's "assume visible" fallback: an eager author lookup is a
 * good failure, a timeline that pages itself unprompted is not.
 */
export function whileVisible(node: HTMLElement, callback?: (visible: boolean) => void) {
  if (typeof IntersectionObserver === 'undefined') {
    return { update: () => {}, destroy: () => {} };
  }

  let current = callback;
  const observer = new IntersectionObserver(
    (entries) => {
      current?.(entries.some((entry) => entry.isIntersecting));
    },
    // The same margin `whenVisible` uses: start the page just before the reader
    // reaches the end, so the events are there by the time they are scrolled to.
    { rootMargin: '200px' }
  );
  observer.observe(node);
  return {
    update: (next?: (visible: boolean) => void) => {
      current = next;
    },
    destroy: () => observer.disconnect(),
  };
}
