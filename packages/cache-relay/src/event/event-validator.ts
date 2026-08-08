import type { NostrEvent } from '@nostr-cache/shared';
import { verifier } from '@rx-nostr/crypto';

/**
 * Event validator for Nostr Cache Relay
 * Validates Nostr events
 */
export class EventValidator {
  async validate(event: NostrEvent): Promise<boolean> {
    try {
      return verifier(event);
    } catch (error) {
      return false;
    }
  }
}
