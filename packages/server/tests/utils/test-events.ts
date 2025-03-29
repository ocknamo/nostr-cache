/**
 * テストイベント生成関数
 */

import type { NostrEvent } from '@nostr-cache/types';
import { seckeySigner } from 'rx-nostr-crypto';
import { getRandomSecret } from './get-random-secret.js';

/**
 * Create a test event
 * @param seckey 秘密鍵（オプション）
 * @param overrides イベントのプロパティをオーバーライド
 * @returns NostrEvent object
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
