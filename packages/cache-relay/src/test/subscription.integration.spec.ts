/**
 * Subscription Manager Integration Tests
 *
 * Tests the interaction between MessageHandler and SubscriptionManager
 */

import { type NostrEvent, NostrMessageType } from '@nostr-cache/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationTestBase, createTestEvent } from './utils/base.integration';

describe('Subscription Integration', () => {
  let testBase: IntegrationTestBase;

  // Setup before each test (with extended timeout)
  beforeEach(async () => {
    testBase = new IntegrationTestBase();
    await testBase.setup();
  });

  // Cleanup after each test
  afterEach(async () => {
    await testBase.teardown();
  });

  describe('Subscription Management', () => {
    it('should create subscriptions and store them', async () => {
      // Create a subscription
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Verify subscription was created
      const subscription = testBase.subscriptionManager.getSubscription('test-client', 'sub1');
      expect(subscription).toBeDefined();
      expect(subscription?.id).toBe('sub1');
      expect(subscription?.clientId).toBe('test-client');
      expect(subscription?.filters).toHaveLength(1);
      expect(subscription?.filters[0].kinds).toEqual([1]);
    });

    it('should handle multiple subscriptions per client', async () => {
      // Create multiple subscriptions for same client
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      await testBase.messageHandler.handleMessage('test-client', [
        'REQ',
        'sub2',
        { authors: ['test-author'] },
      ]);

      // Verify both subscriptions were created
      const subscription1 = testBase.subscriptionManager.getSubscription('test-client', 'sub1');
      const subscription2 = testBase.subscriptionManager.getSubscription('test-client', 'sub2');

      expect(subscription1).toBeDefined();
      expect(subscription2).toBeDefined();
      expect(subscription1?.id).toBe('sub1');
      expect(subscription2?.id).toBe('sub2');

      // Verify client subscriptions
      const clientSubs = testBase.subscriptionManager.getClientSubscriptions('test-client');
      expect(clientSubs).toHaveLength(2);
    });

    it('should remove subscriptions on CLOSE message', async () => {
      // Create a subscription
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Verify subscription exists
      expect(testBase.subscriptionManager.getSubscription('test-client', 'sub1')).toBeDefined();

      // Close the subscription
      await testBase.messageHandler.handleMessage('test-client', ['CLOSE', 'sub1']);

      // Verify subscription was removed
      expect(testBase.subscriptionManager.getSubscription('test-client', 'sub1')).toBeUndefined();
    });

    it('should replace subscriptions with same ID', async () => {
      // Create a subscription
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Replace it with new filter
      await testBase.messageHandler.handleMessage('test-client', [
        'REQ',
        'sub1',
        { authors: ['new-author'] },
      ]);

      // Verify subscription was updated
      const subscription = testBase.subscriptionManager.getSubscription('test-client', 'sub1');
      expect(subscription).toBeDefined();
      expect(subscription?.filters).toHaveLength(1);
      expect(subscription?.filters[0].kinds).toBeUndefined();
      expect(subscription?.filters[0].authors).toEqual(['new-author']);
    });

    it('should handle multiple clients with same subscription IDs', async () => {
      // Create subscriptions for two different clients with same ID
      await testBase.messageHandler.handleMessage('client1', ['REQ', 'sub1', { kinds: [1] }]);

      await testBase.messageHandler.handleMessage('client2', [
        'REQ',
        'sub1',
        { authors: ['test-author'] },
      ]);

      // Verify both subscriptions exist with different filters
      const sub1 = testBase.subscriptionManager.getSubscription('client1', 'sub1');
      const sub2 = testBase.subscriptionManager.getSubscription('client2', 'sub1');

      expect(sub1).toBeDefined();
      expect(sub2).toBeDefined();
      expect(sub1?.filters[0].kinds).toEqual([1]);
      expect(sub2?.filters[0].authors).toEqual(['test-author']);
    });
  });

  describe('Subscription Filtering', () => {
    it('should filter events based on subscription criteria', async () => {
      // Create test events
      const event1 = await createTestEvent(undefined, {
        kind: 1,
      });

      const event2 = await createTestEvent(undefined, {
        kind: 1000,
      });

      // Store events
      await testBase.storage.saveEvent(event1);
      await testBase.storage.saveEvent(event2);

      // Track events received by subscription
      const receivedEvents: string[] = [];
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EVENT) {
          const event = msg[2] as NostrEvent;
          receivedEvents.push(event.id);
        }
      });

      // Create subscription that matches only event1
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Check that only event1 was returned with subscription
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toBe(event1.id);
    });

    it('should handle complex filter combinations', async () => {
      // Create test events with different properties
      const event1 = await createTestEvent(undefined, {
        kind: 1,
        created_at: 1000,
        tags: [['e', 'ref1']],
      });

      const event2 = await createTestEvent(undefined, {
        kind: 1,
        created_at: 2000,
        tags: [['e', 'ref1']],
      });

      const event3 = await createTestEvent(undefined, {
        kind: 2,
        created_at: 3000,
        tags: [['e', 'ref2']],
      });

      // Store all events
      await testBase.storage.saveEvent(event1);
      await testBase.storage.saveEvent(event2);
      await testBase.storage.saveEvent(event3);

      // Create subscription with complex filter
      const receivedEvents: string[] = [];
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EVENT) {
          const event = msg[2] as NostrEvent;
          receivedEvents.push(event.id);
        }
      });

      // Complex filter: (kind=1 AND author=author1) OR has #e=ref1
      await testBase.messageHandler.handleMessage('test-client', [
        'REQ',
        'sub1',
        { kinds: [1], authors: ['author1'] },
        { '#e': ['ref1'] },
      ]);

      // Should match event1 (kind=1, author1) and event2 (has #e=ref1)
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents).toContain(event1.id);
      expect(receivedEvents).toContain(event2.id);
      expect(receivedEvents).not.toContain(event3.id);
    });

    it('should send EOSE after delivering initial events', async () => {
      // Store a test event
      const event = await createTestEvent();
      await testBase.storage.saveEvent(event);

      // Track EOSE messages
      let eoseReceived = false;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EOSE) {
          eoseReceived = true;
        }
      });

      // Create subscription
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Verify EOSE was sent
      expect(eoseReceived).toBe(true);
    });

    it('should deliver new matching events to existing subscriptions', async () => {
      // Create subscription first
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Track events received by subscription
      const receivedEvents: string[] = [];
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EVENT && msg[1] === 'sub1') {
          const event = msg[2] as NostrEvent;
          receivedEvents.push(event.id);
        }
      });

      // Wait a bit to ensure subscription is created
      await new Promise((r) => setTimeout(r, 50));

      // Now publish a matching event
      const event = await createTestEvent(undefined, {
        kind: 1,
      });
      await testBase.messageHandler.handleMessage('publisher', ['EVENT', event]);

      // Verify the event was delivered to subscription
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toBe(event.id);
    });
  });

  describe('Performance', () => {
    it('should handle a large number of events', async () => {
      // Create subscription
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub1', { kinds: [1] }]);

      // Count received events
      let eventCount1 = 0;
      let eventCount2 = 0;
      testBase.messageHandler.onResponse((clientId, msg) => {
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EVENT && msg[1] === 'sub1') {
          eventCount1++;
        }
        if (clientId === 'test-client' && msg[0] === NostrMessageType.EVENT && msg[1] === 'sub2') {
          eventCount2++;
        }
      });

      // Generate and publish many events via MessageHandler
      const numEvents = 50;
      for (let i = 0; i < numEvents; i++) {
        const event = await createTestEvent(undefined, {
          kind: 1,
        });
        // MessageHandlerを通してイベントを送信（保存と通知が行われる）
        await testBase.messageHandler.handleMessage('publisher', ['EVENT', event]);
      }

      // Create a new subscription that should match all those events
      await testBase.messageHandler.handleMessage('test-client', ['REQ', 'sub2', { kinds: [1] }]);

      // Verify events were delivered
      expect(eventCount1).toBeGreaterThanOrEqual(numEvents);
      expect(eventCount2).toBeGreaterThanOrEqual(numEvents);
    });
  });
});
