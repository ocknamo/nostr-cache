import type { NostrEvent } from '@nostr-cache/shared';
import { getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from 'rx-nostr-crypto';

/**
 * Signs Nostr events with an in-memory secret key.
 *
 * The default key is randomly generated per session — good enough for
 * demoing the local cache relay. Pass a hex (or nsec1) secret key to use a
 * persistent identity.
 */
export class EventSigner {
  private readonly signer: ReturnType<typeof seckeySigner>;

  constructor(seckey: string = getRandomSecret()) {
    this.signer = seckeySigner(seckey);
  }

  getPublicKey(): Promise<string> {
    return this.signer.getPublicKey();
  }

  /**
   * Build and sign a kind-1 text note with the given content.
   */
  async signTextNote(content: string): Promise<NostrEvent> {
    const event = await this.signer.signEvent({
      kind: 1,
      content,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    return event as NostrEvent;
  }
}
