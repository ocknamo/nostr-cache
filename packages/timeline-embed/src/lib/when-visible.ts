/**
 * A Svelte action that reports the first time its element appears on screen.
 *
 * Everything the widget fetches beyond the timeline itself — an author's kind 0,
 * a quoted event — is fetched for the cards a reader can actually see, and this
 * is the trigger both of them hang off. A timeline holds 50 events by default
 * and can hold 500; looking all of them up on first paint would cost the
 * embedding page a burst of requests for cards nobody scrolled to.
 */

/**
 * Report the element's first appearance on screen, then stop watching.
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
