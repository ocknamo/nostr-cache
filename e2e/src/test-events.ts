/**
 * Signed test event helpers for E2E tests.
 *
 * Events reaching the relay are verified with a real signature check
 * (rx-nostr-crypto's verifier), so E2E events must be properly signed.
 * Mirrors packages/server/tests/utils/test-events.ts.
 */

import { type NostrEvent, getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from 'rx-nostr-crypto';

/**
 * Create a signed Nostr event.
 *
 * @param seckey Optional hex secret key; a random one is generated when omitted
 * @param overrides Event fields to override (id/pubkey/sig are always derived)
 * @returns A signed NostrEvent
 */
export async function createTestEvent(
  seckey?: string,
  overrides: Omit<Partial<NostrEvent>, 'id' | 'pubkey' | 'sig'> = {}
): Promise<NostrEvent> {
  const hexSecKey = seckey || getRandomSecret();
  const signer = seckeySigner(hexSecKey);
  const pubkey = await signer.getPublicKey();

  const event = {
    pubkey,
    created_at: 1234567890,
    kind: 1,
    tags: [['p', pubkey]],
    content: 'test content',
    ...overrides,
  };

  return signer.signEvent(event);
}

export { getRandomSecret };
