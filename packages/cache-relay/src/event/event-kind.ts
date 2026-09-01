/**
 * イベント種別の判定（NIP-01 の kind 範囲）。
 * イベントパイプラインと両ストレージアダプタが同じ判定を使うための純粋関数。
 */

/** Kind of a NIP-09 deletion request event. */
export const DELETION_EVENT_KIND = 5;

/**
 * Regular replaceable event: only the newest event per (pubkey, kind) is kept.
 * Covers kind 0 (metadata), kind 3 (follow list, NIP-02) and 10000–19999.
 */
export function isReplaceableKind(kind: number): boolean {
  return (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
}

/** Ephemeral event (20000–29999): broadcast to subscribers but never stored. */
export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/**
 * Addressable (parameterized replaceable) event (30000–39999): only the newest
 * event per (pubkey, kind, `d` tag value) is kept.
 */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function isDeletionKind(kind: number): boolean {
  return kind === DELETION_EVENT_KIND;
}

/**
 * `a` タグの座標で参照できる kind か。通常 kind の座標（`1:<pubkey>:`）を弾くために使う。
 * 通せば 1 つのタグが「この著者の kind 1 を全削除」になる。
 */
export function isCoordinateAddressableKind(kind: number): boolean {
  return isReplaceableKind(kind) || isAddressableKind(kind);
}
