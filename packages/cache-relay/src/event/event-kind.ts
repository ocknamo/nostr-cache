/**
 * Event kind classification (NIP-01 kind ranges).
 *
 * Dependency-free pure predicates so the event pipeline and both storage
 * adapters (Dexie / SQLite) classify kinds from a single source of truth —
 * the same pattern as `storage/tag-index.ts` and `storage/priority.ts`.
 */

/** Kind of a NIP-09 deletion request event. */
export const DELETION_EVENT_KIND = 5;

/**
 * Regular replaceable event: only the newest event per (pubkey, kind) is kept.
 * Covers kind 0 (metadata), kind 3 (follow list, NIP-02) and 10000–19999.
 *
 * @param kind Event kind
 * @returns True if only the newest event per (pubkey, kind) is retained
 */
export function isReplaceableKind(kind: number): boolean {
  return (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
}

/**
 * Ephemeral event (20000–29999): broadcast to subscribers but never stored.
 *
 * @param kind Event kind
 * @returns True if the event must not be persisted
 */
export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/**
 * Addressable (parameterized replaceable) event (30000–39999): only the newest
 * event per (pubkey, kind, `d` tag value) is kept.
 *
 * @param kind Event kind
 * @returns True if only the newest event per (pubkey, kind, d) is retained
 */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * NIP-09 deletion request (kind 5).
 *
 * @param kind Event kind
 * @returns True if the event is a deletion request
 */
export function isDeletionKind(kind: number): boolean {
  return kind === DELETION_EVENT_KIND;
}

/**
 * Whether a kind can be referenced by an `a` tag coordinate
 * (`<kind>:<pubkey>:<d-identifier>`) — i.e. replaceable or addressable.
 *
 * Used to reject NIP-09 `a` tags naming a regular kind: `1:<pubkey>:` would
 * otherwise mean "delete every kind 1 note by this author up to the deletion
 * request's created_at", turning one malformed tag into a mass deletion.
 *
 * @param kind Event kind
 * @returns True if the kind is addressed by a coordinate rather than an id
 */
export function isCoordinateAddressableKind(kind: number): boolean {
  return isReplaceableKind(kind) || isAddressableKind(kind);
}
