/**
 * Library entry point.
 *
 * `packages/demo-site` consumes these directly (the package `exports` map
 * points at this source file), so the demo renders the very same components
 * and cache instrumentation that ship in the embed bundle.
 */

export { default as EventCard } from './components/EventCard.svelte';
export { default as Timeline } from './components/Timeline.svelte';
export { default as NostrTimeline } from './nostr-timeline.svelte';

export { CacheMetrics } from './lib/cache-metrics.ts';
export type { EventOrigin, MetricsSnapshot } from './lib/cache-metrics.ts';
export { InstrumentedUpstreamPool } from './lib/instrumented-upstream-pool.ts';
export type { UpstreamObserver } from './lib/instrumented-upstream-pool.ts';
export { RelayConnection } from './lib/relay-connection.ts';
export type {
  ConnectionStatus,
  RelayConnectionOptions,
  SubscriptionHandlers,
} from './lib/relay-connection.ts';
export {
  DEFAULT_DB_NAME,
  DEFAULT_INTERCEPT_URL,
  DEFAULT_LAZY_VALIDATE_INTERVAL,
  acquireRelayHost,
  getRelayHostRefCount,
} from './lib/relay-host.ts';
export type { RelayHost, RelayHostConfig } from './lib/relay-host.ts';
export { RequestTimer } from './lib/request-timer.ts';
export type { RequestDurations, RequestTiming } from './lib/request-timer.ts';
export {
  DEFAULT_KINDS,
  DEFAULT_LIMIT,
  configFromSearchParams,
  parseFilter,
  parseRelays,
} from './lib/timeline-config.ts';
export type { FilterInput } from './lib/timeline-config.ts';
export { TimelineController } from './lib/timeline-controller.ts';
export type { TimelineControllerOptions, TimelineState } from './lib/timeline-controller.ts';
export { DEFAULT_TIMELINE_CAP, insertEvent } from './lib/timeline-utils.ts';
export { fetchValidationStatuses, hasPending } from './lib/validation-status.ts';
export type { ValidationStatus } from './lib/validation-status.ts';
