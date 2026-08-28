import type { RelayConnection } from '../relay-connection.ts';

/**
 * All a lookup helper is allowed to know about the controller driving it.
 *
 * Deliberately narrow: the helpers own their subscriptions and their slice of
 * state, and nothing here reaches the timeline's.
 */
export interface LookupContext {
  connection: RelayConnection;
  /** False once the controller is stopped or suspended. */
  isActive(): boolean;
  /**
   * Every rendered event goes through this, so the cache/upstream counters
   * describe one population rather than a subset of the upstream one.
   */
  classifyDelivered(eventId: string): void;
}
