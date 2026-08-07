/**
 * Type declarations for the widget's custom elements so the demo can use them
 * in Svelte markup with checked attributes. The elements themselves are
 * registered by importing `@nostr-cache/timeline-embed/embed`.
 */
declare namespace svelteHTML {
  interface IntrinsicElements {
    /**
     * The follow timeline. Deliberately has no `authors` / `filters`: its
     * authors come from the subject's NIP-02 follow list at runtime.
     */
    'nostr-follow-timeline': {
      /** Whose follows to walk: hex, `npub` or `nprofile`. Required. */
      pubkey?: string;
      relays?: string;
      kinds?: string;
      limit?: string;
      'max-follows'?: string;
      'include-self'?: string;
      'since-days'?: string;
      'follows-freshness'?: string;
      'db-name'?: string;
      'profile-freshness'?: string;
      debug?: string | boolean;
      'show-avatars'?: string;
      'show-media'?: string;
    };
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
