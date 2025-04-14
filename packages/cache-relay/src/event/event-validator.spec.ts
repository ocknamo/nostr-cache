/**
 * Tests for EventValidator
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { EventValidator } from './event-validator.js';

describe('EventValidator', () => {
  // Sample event
  const sampleEvent: NostrEvent = {
    content: 'sample',
    created_at: 1742660714,
    tags: [],
    kind: 1,
    pubkey: '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958',
    id: '76c5977733a360c46c0e28548e2d06feb28292cdf53d0f0df0b8ad352ba3b654',
    sig: '5057c68f57d829758af5090beb86738bdd09679f0997995b6d7f2b012c3698ff0519f79f01d5b44704c393a145caea1f415908b486ba0d34359134386b9a4650',
  };

  let validator: EventValidator;

  beforeEach(() => {
    validator = new EventValidator();
  });

  describe('validate', () => {
    it('should return true for any event (placeholder implementation)', async () => {
      const result = await validator.validate(sampleEvent);

      expect(result).toBe(true);
    });

    it('should return false with invalid events', async () => {
      const events = [
        // Different kind
        {
          ...sampleEvent,
          kind: 2,
        },
        // Different content
        {
          ...sampleEvent,
          content: 'Different content',
        },
        // With tags
        {
          ...sampleEvent,
          tags: [
            ['e', '456'],
            ['p', 'def'],
          ],
        },
        // Different created_at
        {
          ...sampleEvent,
          created_at: Math.floor(Date.now() / 1000) - 3600,
        },
      ];

      for (const event of events) {
        const result = await validator.validate(event);
        expect(result).toBe(false);
      }
    });
  });
});
