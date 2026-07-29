/**
 * Entry point for the standalone embed bundle.
 *
 * Importing the component registers the `<nostr-timeline>` custom element as a
 * side effect (Svelte's custom-element output calls `customElements.define` at
 * module evaluation), so a page only has to load this one script.
 */

import NostrTimeline from './nostr-timeline.svelte';

export default NostrTimeline;
