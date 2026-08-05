/**
 * Event Handler Integration Tests
 *
 * Tests the interaction between MessageHandler and EventHandler
 */

import type { NostrEvent, NostrWireMessage } from '@nostr-cache/shared';
import { getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from 'rx-nostr-crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationTestBase, createTestEvent } from './utils/base.integration.js';

describe('Event Handler Integration', () => {
  let testBase: IntegrationTestBase;

  // Setup before each test
  beforeEach(async () => {
    testBase = new IntegrationTestBase();
    await testBase.setup();
  });

  // Cleanup after each test
  afterEach(async () => {
    await testBase.teardown();
  });

  describe('Event processing', () => {
    it('should store and validate regular events', async () => {
      // Create test event
      const event = await createTestEvent();

      // Process event through MessageHandler
      const result = await testBase.messageHandler.handleMessage('test-client', ['EVENT', event]);

      // Verify event was stored
      const storedEvents = await testBase.storage.getEvents([{ ids: [event.id] }]);
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0].id).toBe(event.id);
    });

    it('should handle replaceable events', async () => {
      const seckey = getRandomSecret();
      // Create a replaceable event (kind 0)
      const event1 = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1000,
        content: 'First version',
      });

      // Process first event
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', event1]);

      // Create a newer replaceable event with same kind and pubkey
      const event2 = await createTestEvent(seckey, {
        kind: 0,
        created_at: 2000, // Newer timestamp
        content: 'Second version',
      });

      // Process second event
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', event2]);

      // Verify only the newer event is returned
      const storedEvents = await testBase.storage.getEvents([
        { kinds: [0], authors: [event1.pubkey] },
      ]);
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0].id).toBe(event2.id);
      expect(storedEvents[0].content).toBe('Second version');
    });

    it('should keep the newest version when an older one arrives afterwards', async () => {
      // NIP-01: 置換可能イベントは最新の1件だけを保持する。古い署名済みイベントを
      // 後から投げるだけで新しい版を上書きできてはならない
      const seckey = getRandomSecret();
      const newer = await createTestEvent(seckey, {
        kind: 0,
        created_at: 2000,
        content: 'Second version',
      });
      const older = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1000,
        content: 'First version',
      });

      await testBase.messageHandler.handleMessage('test-client', ['EVENT', newer]);

      const okMessages: NostrWireMessage[] = [];
      const broadcasts: NostrWireMessage[] = [];
      // 古い版を配信させないため、先に購読しておく
      await testBase.messageHandler.handleMessage('test-client', [
        'REQ',
        'sub1',
        { kinds: [0], authors: [newer.pubkey] },
      ]);
      testBase.messageHandler.onResponse((_clientId, msg) => {
        if (msg[0] === 'OK') okMessages.push(msg);
        if (msg[0] === 'EVENT') broadcasts.push(msg);
      });

      await testBase.messageHandler.handleMessage('test-client', ['EVENT', older]);

      // 保存されているのは新しい版のみ
      const storedEvents = await testBase.storage.getEvents([
        { kinds: [0], authors: [newer.pubkey] },
      ]);
      expect(storedEvents).toHaveLength(1);
      expect(storedEvents[0].id).toBe(newer.id);
      expect(storedEvents[0].content).toBe('Second version');

      // 受理はするが（OK true）、購読者へは配信しない
      expect(okMessages).toHaveLength(1);
      expect(okMessages[0][1]).toBe(older.id);
      expect(okMessages[0][2]).toBe(true);
      expect(okMessages[0][3]).toMatch(/^duplicate: /);
      expect(broadcasts).toHaveLength(0);
    });

    it('should keep the lowest id when two versions share created_at', async () => {
      const seckey = getRandomSecret();
      const first = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1000,
        content: 'first',
      });
      const second = await createTestEvent(seckey, {
        kind: 0,
        created_at: 1000,
        content: 'second',
      });
      // NIP-01 の同着タイブレークは id の辞書順（到着順に依存しない）
      const [lower, higher] = [first, second].sort((a, b) => (a.id < b.id ? -1 : 1));

      await testBase.messageHandler.handleMessage('test-client', ['EVENT', higher]);
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', lower]);

      const afterBoth = await testBase.storage.getEvents([{ kinds: [0], authors: [first.pubkey] }]);
      expect(afterBoth).toHaveLength(1);
      expect(afterBoth[0].id).toBe(lower.id);

      // 逆順で再送しても結果は変わらない
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', higher]);
      const afterResend = await testBase.storage.getEvents([
        { kinds: [0], authors: [first.pubkey] },
      ]);
      expect(afterResend).toHaveLength(1);
      expect(afterResend[0].id).toBe(lower.id);
    });

    it('should keep the newest version per d tag for addressable events', async () => {
      const seckey = getRandomSecret();
      const newer = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 2000,
        tags: [['d', 'slug']],
        content: 'newer',
      });
      const older = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 1000,
        tags: [['d', 'slug']],
        content: 'older',
      });
      // 別の d タグは別の座標なので、古くても保存される
      const otherSlug = await createTestEvent(seckey, {
        kind: 30023,
        created_at: 1000,
        tags: [['d', 'other']],
        content: 'other slug',
      });

      await testBase.messageHandler.handleMessage('test-client', ['EVENT', newer]);
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', older]);
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', otherSlug]);

      const storedEvents = await testBase.storage.getEvents([
        { kinds: [30023], authors: [newer.pubkey] },
      ]);
      expect(storedEvents.map((event) => event.id).sort()).toEqual([newer.id, otherSlug.id].sort());
    });

    it('should handle ephemeral events', async () => {
      // Create an ephemeral event (kind 20000+)
      const event = await createTestEvent(getRandomSecret(), {
        kind: 20001,
        content: 'Ephemeral content',
      });

      // Process ephemeral event
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', event]);

      // Verify ephemeral event is not stored
      const storedEvents = await testBase.storage.getEvents([{ ids: [event.id] }]);
      expect(storedEvents).toHaveLength(0);
    });

    it('should reject invalid events', async () => {
      // Create invalid event (missing required fields)
      const invalidEvent = {
        id: 'invalid-id',
        pubkey: '', // Invalid empty pubkey
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'Invalid event',
        sig: 'invalid-sig',
      } as NostrEvent;

      // Set up response collector
      let responseMessage: NostrWireMessage | null = null;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === 'OK') {
          responseMessage = msg;
        }
      });

      // Process invalid event
      await testBase.messageHandler.handleMessage('test-client', ['EVENT', invalidEvent]);

      // Verify event was rejected
      expect(responseMessage).not.toBeNull();
      if (responseMessage) {
        expect(responseMessage[0]).toBe('OK');
        expect(responseMessage[1]).toBe('invalid-id');
        expect(responseMessage[2]).toBe(false); // success = false
      }
    });
  });

  describe('Event matching', () => {
    it('should match events to subscriptions by kind', async () => {
      // Create subscription
      await testBase.messageHandler.handleMessage('sub-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Create client for receiving messages
      let receivedEvent: unknown = null;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'sub-client' && msg[0] === 'EVENT' && msg[1] === 'sub1') {
          // The EVENT message format is ['EVENT', subscriptionId, event]
          receivedEvent = msg[2];
        }
      });

      // Create and publish event
      const event = await createTestEvent(getRandomSecret(), { kind: 1 });
      await testBase.messageHandler.handleMessage('pub-client', ['EVENT', event]);

      // Verify client received the event
      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as NostrEvent).id).toBe(event.id);
    });

    it('should match events to subscriptions by author', async () => {
      const hexSecKey1 = getRandomSecret();
      const signer1 = seckeySigner(hexSecKey1);
      const author = await signer1.getPublicKey();

      const hexSecKey2 = getRandomSecret();

      // Create subscription for specific author
      await testBase.messageHandler.handleMessage('sub-client', [
        'REQ',
        'sub1',
        { authors: [author] },
      ]);

      // Set up response collector
      let receivedEvent: unknown = null;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'sub-client' && msg[0] === 'EVENT' && msg[1] === 'sub1') {
          // The EVENT message format is ['EVENT', subscriptionId, event]
          receivedEvent = msg[2] ?? null;
        }
      });

      // Create and publish matching event
      const matchingEvent = await createTestEvent(hexSecKey1);
      await testBase.messageHandler.handleMessage('pub-client', ['EVENT', matchingEvent]);

      // Verify client received the event
      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as NostrEvent).id).toBe(matchingEvent.id);

      // Reset collector
      receivedEvent = null;

      // Create and publish non-matching event
      const nonMatchingEvent = await createTestEvent(hexSecKey2);
      await testBase.messageHandler.handleMessage('pub-client', ['EVENT', nonMatchingEvent]);

      // Verify client did not receive the event
      expect(receivedEvent).toBeNull();
    });

    it('should match events to subscriptions by tag', async () => {
      // Create subscription for specific e-tag
      await testBase.messageHandler.handleMessage('sub-client', [
        'REQ',
        'sub1',
        { '#e': ['specific-event-id'] },
      ]);

      // Set up response collector
      let receivedEvent: unknown = null;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'sub-client' && msg[0] === 'EVENT' && msg[1] === 'sub1') {
          // The EVENT message format is ['EVENT', subscriptionId, event]
          receivedEvent = msg[2] ?? null;
        }
      });

      // Create and publish matching event
      const matchingEvent = await createTestEvent(getRandomSecret(), {
        tags: [
          ['e', 'specific-event-id'],
          ['p', 'someone'],
        ],
      });
      await testBase.messageHandler.handleMessage('pub-client', ['EVENT', matchingEvent]);

      // Verify client received the event
      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as NostrEvent).id).toBe(matchingEvent.id);

      // Reset collector
      receivedEvent = null;

      // Create and publish non-matching event
      const nonMatchingEvent = await createTestEvent(getRandomSecret(), {
        tags: [
          ['e', 'other-event-id'],
          ['p', 'someone'],
        ],
      });
      await testBase.messageHandler.handleMessage('pub-client', ['EVENT', nonMatchingEvent]);

      // Verify client did not receive the event
      expect(receivedEvent).toBeNull();
    });
  });

  describe('Event time-based filtering', () => {
    it('should filter events by time range', async () => {
      // Create events with different timestamps
      const event1 = await createTestEvent(getRandomSecret(), {
        created_at: 1000,
      });

      const event2 = await createTestEvent(getRandomSecret(), {
        created_at: 2000,
      });

      const event3 = await createTestEvent(getRandomSecret(), {
        created_at: 3000,
      });

      // Store all events
      await testBase.storage.saveEvent(event1);
      await testBase.storage.saveEvent(event2);
      await testBase.storage.saveEvent(event3);

      // Create subscription with time range
      const receivedEvents: string[] = [];
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'sub-client' && msg[0] === 'EVENT' && msg[1] === 'sub1') {
          const eventObj = msg[2] as NostrEvent;
          receivedEvents.push(eventObj.id);
        }
      });

      // Subscribe with time filter
      await testBase.messageHandler.handleMessage('sub-client', [
        'REQ',
        'sub1',
        { since: 1500, until: 2500 },
      ]);

      // Verify only event2 was received (created_at = 2000)
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toBe(event2.id);
    });
  });
});
