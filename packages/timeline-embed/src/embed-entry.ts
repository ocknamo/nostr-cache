/**
 * Entry point for the standalone embed bundle.
 *
 * Importing the components registers `<nostr-timeline>`,
 * `<nostr-follow-timeline>` and `<nostr-post>` as a side effect (Svelte's
 * custom-element output calls `customElements.define` at module evaluation), so
 * a page only has to load this one script to use any of them. They share
 * almost everything below the filter — the relay, the card, the action bar — so
 * carrying all three costs a few KB rather than three bundles.
 *
 * The bundle also publishes the page-shared relay directly, so a page can run
 * the cache without mounting a widget: any Nostr client that can be pointed at
 * a URL connects to `interceptUrl` and reads through the same IndexedDB cache
 * the widgets use. Everything re-exported here is already in the bundle (the
 * widgets call it), so the exports cost nothing but the property names.
 */

// Imported purely for the registration side effect. All three components are
// exported properly from `src/index.ts`, for library users; this entry point
// deliberately publishes only the relay API, so what the bundle's global
// carries stays small enough to describe in the README.
import './nostr-follow-timeline.svelte';
import './nostr-post.svelte';
import NostrTimeline from './nostr-timeline.svelte';

export {
  DEFAULT_DB_NAME,
  DEFAULT_FOLLOWS_FRESHNESS,
  DEFAULT_INTERCEPT_URL,
  DEFAULT_LAZY_VALIDATE_INTERVAL,
  DEFAULT_PROFILE_FRESHNESS,
  acquireRelayHost,
  getRelayHostRefCount,
} from './lib/relay-host.ts';
export type { RelayHost, RelayHostConfig } from './lib/relay-host.ts';

/**
 * Kept as the default export for the pages that loaded this bundle before it
 * had named ones. Note that adding them moved the component off the IIFE global
 * itself: `globalThis.NostrTimelineEmbed` is now the module namespace, so the
 * component is `NostrTimelineEmbed.default`. Only direct JS access sees that —
 * `<nostr-timeline>` in markup goes through `customElements`, untouched.
 */
export default NostrTimeline;
