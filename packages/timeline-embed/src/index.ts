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
export { default as EmbeddedNote } from './components/EmbeddedNote.svelte';
export { default as EventCard } from './components/EventCard.svelte';
export { default as MediaAttachment } from './components/MediaAttachment.svelte';
export { default as NoteContent } from './components/NoteContent.svelte';
export { default as PostView } from './components/PostView.svelte';
export { default as ReactionBar } from './components/ReactionBar.svelte';
export { default as ReactionList } from './components/ReactionList.svelte';
export { default as ReplyBranch } from './components/ReplyBranch.svelte';
export { default as ReplyTree } from './components/ReplyTree.svelte';
export { default as Timeline } from './components/Timeline.svelte';
export { default as TimelineView } from './components/TimelineView.svelte';
export { default as NostrFollowTimeline } from './nostr-follow-timeline.svelte';
export { default as NostrPost } from './nostr-post.svelte';
export { default as NostrTimeline } from './nostr-timeline.svelte';

export * from './lib/index.ts';
