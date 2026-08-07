/**
 * Fetch a single replaceable event and close the subscription again.
 *
 * Extracted because the follow-list fetch is the same shape as the profile
 * fetch `TimelineController` already does, and that one needed three separate
 * corrections to be right (`doc/plan/follow-timeline.md` §5). Written out a
 * second time, at least one of them would have been missed:
 *
 * 1. **EOSE did not mean "delivered".** The relay used to emit EOSE as soon as
 *    the upstream pool reported end-of-stored, without waiting for the events it
 *    was still ingesting, so closing on EOSE threw away the very event that had
 *    just been fetched. That was a defect in `UpstreamCoordinator`, since fixed
 *    — `flushEose` now waits for its ingest chain — which is why
 *    {@link DEFAULT_ONE_SHOT_GRACE_MS} is zero. The knob remains for relays
 *    that are not ours.
 * 2. **The first event is not necessarily the newest.** Two upstream relays can
 *    each answer with their own copy of a replaceable event, in either order, so
 *    the winner is decided by NIP-01's version ordering (`supersedes`) rather
 *    than by arrival.
 * 3. **A refused REQ answers with nothing at all.** A subscription cap or a
 *    storage read failure gets a NOTICE and no EOSE or CLOSED, so without a
 *    watchdog the caller waits forever.
 *
 * The existing profile lookups are deliberately *not* moved onto this helper
 * here: they are entangled with a concurrency budget, a bulk-cancel path,
 * per-delivery metrics and a reconnect pump (§5), and rewriting that is its own
 * change. `onEvent` and `signal` exist so that migration stays possible.
 */

import { supersedes } from '@nostr-cache/cache-relay/browser';
import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { RelayConnection } from './relay-connection.ts';

/**
 * How long the subscription stays open after EOSE.
 *
 * Zero, because the relay now orders EOSE after the events it has accepted:
 * `UpstreamCoordinator.flushEose` waits for its ingest chain, so "end of
 * stored" means every stored event really has been delivered. The window this
 * used to hold open was covering a defect in the relay, not something NIP-01
 * requires a client to tolerate — and it delayed every follow timeline's first
 * paint by half a second.
 *
 * Kept as a knob rather than deleted: `RelayConnection` can be pointed at any
 * relay, and a third-party one may still release EOSE early.
 */
export const DEFAULT_ONE_SHOT_GRACE_MS = 0;
/**
 * Hard deadline on one lookup.
 *
 * Covers the relay's upstream EOSE timeout (3s) plus the grace above. Its real
 * job is the case where no reply of any kind arrives.
 */
export const DEFAULT_ONE_SHOT_TIMEOUT_MS = 5000;

/** Distinguishes concurrent lookups on the shared connection. */
let sequence = 0;

export interface OneShotRequestOptions {
  graceMs?: number;
  timeoutMs?: number;
  /**
   * Resolves with `undefined` and closes the subscription.
   *
   * Without it a caller torn down mid-fetch leaves a REQ open on the relay:
   * this subscription is opened outside the controller's profile bookkeeping,
   * so none of its bulk-close paths would reach it.
   */
  signal?: AbortSignal;
  /**
   * Called for every delivered event, including copies that lost the
   * `created_at` comparison.
   *
   * A caller may need to account for deliveries it does not use —
   * `CacheMetrics.classifyDelivered` has to see the same population the
   * upstream pool counted, or the two counters describe different sets.
   */
  onEvent?: (event: NostrEvent) => void;
}

/**
 * Fetch the newest event matching a filter, then close the subscription.
 *
 * @param connection Live relay connection to issue the REQ on
 * @param filter Filter naming one replaceable coordinate, e.g.
 *   `{kinds:[3],authors:[pubkey]}`
 * @param options Timings, cancellation and per-delivery observation
 * @returns The newest matching event, or `undefined` when none arrived — which
 *   covers "not published", "not upstream" and "the relay never answered"
 *   alike, because none of them is distinguishable from here
 */
export function fetchLatestReplaceable(
  connection: RelayConnection,
  filter: Filter,
  options: OneShotRequestOptions = {}
): Promise<NostrEvent | undefined> {
  const {
    graceMs = DEFAULT_ONE_SHOT_GRACE_MS,
    timeoutMs = DEFAULT_ONE_SHOT_TIMEOUT_MS,
    signal,
    onEvent,
  } = options;

  if (signal?.aborted) {
    return Promise.resolve(undefined);
  }

  sequence += 1;
  const subId = `oneshot-${sequence}`;

  return new Promise((resolve) => {
    let settled = false;
    let newest: NostrEvent | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: NostrEvent | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(grace);
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      connection.unsubscribe(subId);
      resolve(result);
    };

    // An aborted lookup reports nothing rather than what it happened to have
    // collected: the caller is being torn down, and a half-answer would have it
    // act on a filter it is no longer allowed to subscribe with.
    const onAbort = () => finish(undefined);
    const watchdog = setTimeout(() => finish(newest), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    connection.subscribe(subId, [filter], {
      onEvent: (event) => {
        onEvent?.(event);
        // `supersedes` rather than a `created_at` comparison: NIP-01 breaks a
        // tie by keeping the lowest id, and comparing timestamps alone would
        // silently fall back to arrival order — which is decided by whichever
        // upstream relay answered first, so two readers could resolve the same
        // follow list to different author sets. The relay orders its own stored
        // versions with this exact predicate.
        if (!newest || supersedes(event, newest)) {
          newest = event;
        }
      },
      onEose: () => {
        if (grace !== undefined) {
          return;
        }
        grace = setTimeout(() => finish(newest), graceMs);
      },
      // The relay has already dropped the subscription, so there is nothing
      // more to wait for — take whatever arrived before it did.
      onClosed: () => finish(newest),
    });
  });
}
