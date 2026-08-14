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
      'show-embeds'?: string;
      /** JSON array of buttons to render under each card. */
      actions?: string;
      /** Render those buttons' icons as Material Symbols of this variant. */
      'material-icons'?: string;
      /** `none` when the embedding page loads the icon font itself. */
      'material-icons-font'?: string;
    };
    /**
     * The post detail. Deliberately has no `filters` / `authors` / `kinds` as
     * a filter: it renders the one event `event-id` names. (`kind` here is
     * part of an addressable coordinate, not a filter.)
     */
    'nostr-post': {
      /** hex id, `note1`, `nevent1` or `naddr1`. Required. */
      'event-id'?: string;
      /** With `kind` and `identifier`: an `naddr` spelled out. */
      author?: string;
      kind?: string;
      identifier?: string;
      relays?: string;
      'db-name'?: string;
      'profile-freshness'?: string;
      'follows-freshness'?: string;
      debug?: string | boolean;
      'show-avatars'?: string;
      'show-media'?: string;
      'show-embeds'?: string;
      /** `"false"` also stops the kind 7 subscription being opened. */
      'show-reactions'?: string | boolean;
      'reactions-limit'?: string;
      'reactions-open'?: string | boolean;
      /** JSON array of buttons to render under the post. */
      actions?: string;
      /** Render those buttons' icons as Material Symbols of this variant. */
      'material-icons'?: string;
      /** `none` when the embedding page loads the icon font itself. */
      'material-icons-font'?: string;
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
      'show-embeds'?: string;
      /** JSON array of buttons to render under each card. */
      actions?: string;
      /** Render those buttons' icons as Material Symbols of this variant. */
      'material-icons'?: string;
      /** `none` when the embedding page loads the icon font itself. */
      'material-icons-font'?: string;
    };
  }
}
