/**
 * Shared plumbing for the iframe host pages.
 *
 * There is one page per custom element (`embed/` and `embed/follow/`), because
 * a query string carries no element type: a single page would have to guess
 * which widget `?pubkey=…&authors=…` meant and silently drop whichever
 * parameters the guessed element does not have — the exact failure that
 * splitting the elements was meant to remove.
 *
 * Keeping the shared half here means the height protocol has one
 * implementation, so that split costs a per-page attribute list and nothing else.
 */

(function () {
  /**
   * @param {string} tag Custom element to create
   * @param {string[]} names Attributes to copy from the query string. The names
   *   match the element's own, so an iframe URL and a Web Component tag
   *   configure the widget the same way.
   */
  window.mountNostrEmbed = function mountNostrEmbed(tag, names) {
    var params = new URLSearchParams(location.search);
    var widget = document.createElement(tag);

    names.forEach(function (name) {
      var value = params.get(name);
      if (value !== null) {
        widget.setAttribute(name, value);
      }
    });

    document.body.appendChild(widget);

    // Report our height so the embedding page can size the iframe to the
    // content instead of guessing (see README for the listener snippet).
    var lastHeight = 0;
    function postHeight() {
      var height = Math.ceil(document.documentElement.scrollHeight);
      if (height === lastHeight) {
        return;
      }
      lastHeight = height;
      // targetOrigin '*' because the embedding origin is unknown by design.
      // The payload is only a height, and the README's receiving snippet
      // checks event.source before acting on it.
      parent.postMessage({ type: 'nostr-timeline:height', height: height }, '*');
    }

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(postHeight).observe(document.body);
    }
    window.addEventListener('load', postHeight);
  };
})();
