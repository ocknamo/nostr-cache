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
export { parseRefs } from './event-refs.ts';
export type { EventRef, EventRefKind } from './event-refs.ts';
export { InstrumentedUpstreamPool } from './instrumented-upstream-pool.ts';
export type { UpstreamObserver } from './instrumented-upstream-pool.ts';
export { authorHandle, authorName, parseProfileContent, shortPubkey } from './profile.ts';
export type { Profile } from './profile.ts';
export { RelayConnection } from './relay-connection.ts';
export type {
  ConnectionStatus,
  RelayConnectionOptions,
  SubscriptionHandlers,
} from './relay-connection.ts';
export {
  DEFAULT_DB_NAME,
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
  parseDebug,
  parseFilter,
  parseFreshness,
  parseRelays,
  parseShowOriginAlias,
} from './timeline-config.ts';
export type { FilterInput } from './timeline-config.ts';
export { TimelineController } from './timeline-controller.ts';
export type { TimelineControllerOptions, TimelineState } from './timeline-controller.ts';
export { DEFAULT_TIMELINE_CAP, insertEvent } from './timeline-utils.ts';
export { fetchValidationStatuses, hasPending } from './validation-status.ts';
export type { ValidationStatus } from './validation-status.ts';
