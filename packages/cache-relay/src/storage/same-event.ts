import type { NostrEvent } from '@nostr-cache/shared';

type Signed = Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>;

/**
 * Whether two events carry the same signed content. An id is checked only by
 * validation, so before that a forgery can reuse a genuine event's id.
 */
export function sameSignedContent(a: Signed, b: Signed): boolean {
  return (
    a.pubkey === b.pubkey &&
    a.created_at === b.created_at &&
    a.kind === b.kind &&
    a.content === b.content &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  );
}

/** Whether a stored row is exactly the event that was validated, signature included. */
export function sameEvent(a: Signed & { sig: string }, b: Signed & { sig: string }): boolean {
  return a.sig === b.sig && sameSignedContent(a, b);
}
