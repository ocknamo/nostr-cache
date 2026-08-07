/**
 * Entry point for the standalone embed bundle.
 *
 * Importing the components registers `<nostr-timeline>` and
 * `<nostr-follow-timeline>` as a side effect (Svelte's custom-element output
 * calls `customElements.define` at module evaluation), so a page only has to
 * load this one script to use either. They share almost everything below the
 * filter, so carrying both costs a few KB rather than a second bundle.
 */

// Imported purely for the registration side effect: the IIFE bundle has a
// single default export, and adding a named one alongside it would force
// consumers onto `NostrTimelineEmbed.default`. Both components are also
// exported properly from `src/index.ts`, for library users.
import './nostr-follow-timeline.svelte';
import NostrTimeline from './nostr-timeline.svelte';

export default NostrTimeline;
