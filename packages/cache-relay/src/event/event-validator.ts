import type { NostrEvent } from '@nostr-cache/shared';
import { verifier } from 'rx-nostr-crypto';

/**
 * Event validator for Nostr Cache Relay
 * Validates Nostr events
 */
export class EventValidator {
  /**
   * Validate a Nostr event
   *
   * @param event Event to validate
   * @returns True if the event is valid, false otherwise
   */
  async validate(event: NostrEvent): Promise<boolean> {
    try {
      return verifier(event);
    } catch (error) {
      return false;
    }
  }
}
