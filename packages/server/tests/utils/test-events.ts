/** テストイベント生成関数 */

import type { NostrEvent } from '@nostr-cache/shared';
import { getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from '@rx-nostr/crypto';

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
