/**
 * Library entry point.
 *
 * `packages/demo-site` consumes these directly (the package `exports` map
 * points at this source file), so the demo renders the very same components
 * and cache instrumentation that ship in the embed bundle.
 *
 * The framework-free half lives in `./lib/index.ts` and is also reachable on
 * its own as `@nostr-cache/timeline-embed/lib`, for consumers that want the
 * shared logic without compiling the components.
 */

export { default as Avatar } from './components/Avatar.svelte';
export { default as EventCard } from './components/EventCard.svelte';
export { default as Timeline } from './components/Timeline.svelte';
export { default as NostrTimeline } from './nostr-timeline.svelte';

export * from './lib/index.ts';
