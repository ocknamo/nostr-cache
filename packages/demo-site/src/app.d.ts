/**
 * Type declaration for the `<nostr-timeline>` custom element so the demo can
 * use it in Svelte markup with checked attributes. The element itself is
 * registered by importing `@nostr-cache/timeline-embed/embed`.
 */
declare namespace svelteHTML {
  interface IntrinsicElements {
    'nostr-timeline': {
      relays?: string;
      kinds?: string;
      authors?: string;
      limit?: string;
      'db-name'?: string;
      'show-origin'?: string;
    };
  }
}
