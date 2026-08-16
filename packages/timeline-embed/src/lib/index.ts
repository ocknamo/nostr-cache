/**
 * Framework-free library entry point.
 *
 * The modules re-exported here are plain TypeScript — no `.svelte` imports — so
 * consumers can pull in the shared relay/timeline logic without compiling the
 * widget's components. `packages/web-client` uses this to run the same relay
 * connection, timeline insertion and validation-status polling as the embed
 * instead of keeping its own copies.
 *
 * Component-facing exports (and the widget itself) live in `../index.ts`.
 */

export { CacheMetrics } from './cache-metrics.ts';
export type { EventOrigin, MetricsSnapshot } from './cache-metrics.ts';
export {
  abbreviateBech32,
  embedKey,
  inlineParts,
  mediaAsLinks,
  mediaParts,
  parseContent,
} from './content-parts.ts';
export type {
  ContentPart,
  EntityPart,
  LinkPart,
  MediaKind,
  MediaPart,
  TextPart,
} from './content-parts.ts';
export {
  PREVIEW_MAX_LENGTH,
  eventPreview,
  mentionLabel,
  notePreview,
} from './content-preview.ts';
export type { PreviewOptions } from './content-preview.ts';
export {
  ACTION_EVENT,
  MAX_ACTIONS,
  dispatchActionEvent,
  normalizeActions,
} from './event-actions.ts';
export type { EventAction, EventActionContext, EventActionDetail } from './event-actions.ts';
export { parseRefs, replyParentAddress, replyParentId } from './event-refs.ts';
export type { EventRef, EventRefKind } from './event-refs.ts';
export { MAX_FILTERS, parseFilterList, toPubkeyHex } from './filter-json.ts';
export {
  DEFAULT_MAX_FOLLOWS,
  followFilterSource,
  parseFollowList,
  selectAuthors,
} from './follow-list.ts';
export type {
  FollowFilterSourceOptions,
  SelectAuthorsOptions,
  SelectedAuthors,
} from './follow-list.ts';
export { InstrumentedUpstreamPool } from './instrumented-upstream-pool.ts';
export {
  ensureMaterialSymbols,
  materialFontFamily,
  materialFontHref,
  parseMaterialVariant,
} from './material-symbols.ts';
export type { MaterialVariant } from './material-symbols.ts';
export type { UpstreamObserver } from './instrumented-upstream-pool.ts';
export {
  MAX_EMBEDS_PER_NOTE,
  MAX_EMBEDS_PER_TOP_NOTE,
  MAX_EMBED_DEPTH,
  embedKeys,
  embedTarget,
  eventIdTarget,
  noteSegments,
  segmentKey,
  segmentMedia,
  selectEmbeds,
} from './note-embeds.ts';
export type { EmbedStatus, EmbedTarget, EmbeddedEvent, NoteSegment } from './note-embeds.ts';
export { fetchLatestReplaceable, latestReplaceable } from './one-shot-request.ts';
export { parsePostTarget } from './post-target.ts';
export type { PostTarget, PostTargetInput, PostTargetMatch } from './post-target.ts';
export {
  authorHandle,
  authorName,
  parseProfileContent,
  safeImageUrl,
  safeText,
  shortPubkey,
  stripUnrenderable,
} from './profile.ts';
export type { Profile } from './profile.ts';
export {
  MAX_LISTED_REACTORS,
  MAX_REACTIONS,
  MAX_REACTION_GROUPS,
  parseReaction,
  summarizeReactionEvents,
  summarizeReactions,
} from './reactions.ts';
export type { Reaction, ReactionGroup, ReactionKind, ReactionSummary } from './reactions.ts';
export {
  DEFAULT_REPLIES_LIMIT,
  DEFAULT_REPLY_DEPTH,
  MAX_REPLIES,
  MAX_REPLY_DEPTH,
  MAX_REPLY_NODES,
  acceptsReply,
  buildReplyTree,
} from './reply-tree.ts';
export type { BuildReplyTreeOptions, ReplyNode, ReplyTree } from './reply-tree.ts';
export { ONE_SHOT_TIMEOUT_MS, RelayConnection } from './relay-connection.ts';
export type {
  ConnectionStatus,
  RelayConnectionOptions,
  SubscriptionHandlers,
} from './relay-connection.ts';
export {
  DEFAULT_DB_NAME,
  DEFAULT_FOLLOWS_FRESHNESS,
  DEFAULT_INTERCEPT_URL,
  DEFAULT_LAZY_VALIDATE_INTERVAL,
  DEFAULT_PROFILE_FRESHNESS,
  acquireRelayHost,
  getRelayHostRefCount,
} from './relay-host.ts';
export type { RelayHost, RelayHostConfig } from './relay-host.ts';
export { RequestTimer } from './request-timer.ts';
export type { RequestDurations, RequestTiming } from './request-timer.ts';
export {
  DEFAULT_KINDS,
  DEFAULT_LIMIT,
  configFromSearchParams,
  followConfigFromSearchParams,
  parseDebug,
  parseEnabled,
  parseFilter,
  parseFilters,
  parseFlag,
  parseFreshness,
  parseKinds,
  parseLimit,
  parseMaxFollows,
  parsePubkey,
  parseReactionsLimit,
  parseRelays,
  parseRepliesDepth,
  parseRepliesLimit,
  parseShowOriginAlias,
  parseSinceDays,
} from './timeline-config.ts';
export type { FilterInput, FollowTimelineConfig } from './timeline-config.ts';
export { TimelineController } from './timeline-controller.ts';
export type {
  FilterSource,
  FilterSourceContext,
  FollowsState,
  PostWatches,
  ReplyRequestOptions,
  TimelineControllerOptions,
  TimelineState,
} from './timeline-controller.ts';
export { DEFAULT_TIMELINE_CAP, insertEvent } from './timeline-utils.ts';
export { fetchValidationStatuses, hasPending } from './validation-status.ts';
export type { ValidationStatus } from './validation-status.ts';
export { whenVisible } from './when-visible.ts';
