import type { RelayConnection } from '../relay-connection.ts';

/**
 * What the lookup helpers are allowed to know about the controller driving
 * them: a socket to speak NIP-01 over, whether lookups are wanted at all, and
 * where a delivered event is counted.
 *
 * Deliberately narrow. The helpers own their own subscriptions and their own
 * slice of state, and nothing here lets them reach the timeline's.
 */
export interface LookupContext {
  connection: RelayConnection;
  /** False once the controller is stopped or suspended. */
  isActive(): boolean;
  /**
   * Count a delivery towards the cache/upstream metrics.
   *
   * Every event the widget renders goes through this, so the counters describe
   * one population: the instrumented upstream pool already counts arrivals as
   * upstream events, and leaving a delivery unclassified would make the
   * delivered/cache-hit numbers cover a smaller set than the upstream one.
   */
  classifyDelivered(eventId: string): void;
}
