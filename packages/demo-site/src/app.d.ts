/**
 * Type declaration for the `<nostr-timeline>` custom element so the demo can
 * use it in Svelte markup with checked attributes. The element itself is
 * registered by importing `@nostr-cache/timeline-embed/embed`.
 */
declare namespace svelteHTML {
  interface IntrinsicElements {
    'nostr-timeline': {
      relays?: string;
      /** JSON array of NIP-01 filters; overrides kinds/authors/limit. */
      filters?: string;
      kinds?: string;
      authors?: string;
      limit?: string;
      'db-name'?: string;
      'profile-freshness'?: string;
      debug?: string | boolean;
      'show-avatars'?: string;
      'show-media'?: string;
    };
  }
}
