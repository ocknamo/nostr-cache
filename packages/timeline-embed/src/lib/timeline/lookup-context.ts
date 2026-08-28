import type { RelayConnection } from '../relay-connection.ts';

/**
 * All a lookup helper knows about the controller driving it. The helpers own
 * their subscriptions and their slice of state; nothing here reaches the
 * timeline's.
 */
export interface LookupContext {
  connection: RelayConnection;
  /** False once the controller is stopped or suspended. */
  isActive(): boolean;
  /** Every rendered event goes through this, or the counters cover a subset. */
  classifyDelivered(eventId: string): void;
}
