/**
 * Tests for MessageHandler
 */

import type { Filter, NostrEvent, NostrWireMessage } from '@nostr-cache/shared';
import { type Mock, vi } from 'vitest';
import { EventValidator } from '../event/event-validator.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { MessageHandler } from './message-handler.js';
import type { SubscriptionManager } from './subscription-manager.js';

describe('MessageHandler', () => {
  // Mock storage adapter
  const mockStorage = {
    saveEvent: vi.fn().mockResolvedValue(true),
    getEvents: vi.fn().mockResolvedValue([]),
    deleteEvent: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
    count: vi.fn().mockResolvedValue(0),
    enforceLimit: vi.fn().mockResolvedValue(0),
    getUnvalidatedEvents: vi.fn().mockResolvedValue([]),
    markValidated: vi.fn().mockResolvedValue(undefined),
    getValidationStatus: vi.fn().mockResolvedValue(new Map()),
  } as StorageAdapter;

  // Mock subscription manager
  const mockSubscriptionManager = {
    subscriptions: new Map(),
    clientSubscriptions: new Map(),
    storage: mockStorage,
    createSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    removeAllSubscriptions: vi.fn(),
    removeSubscriptionByIdForAllClients: vi.fn(),
    getSubscription: vi.fn(),
    getClientSubscriptions: vi.fn(),
    getAllSubscriptions: vi.fn(),
    findMatchingSubscriptions: vi.fn().mockReturnValue(new Map()),
    eventMatchesFilter: vi.fn().mockReturnValue(true),
    getClientSubscriptionCount: vi.fn().mockReturnValue(0),
    getSubscriptionKey: vi
      .fn()
      .mockImplementation((clientId, subscriptionId) => `${clientId}:${subscriptionId}`),
  } as unknown as SubscriptionManager;

  // Sample events
  const sampleEvent: NostrEvent = {
    content: 'sample',
    created_at: 1742660714,
    tags: [],
    kind: 1,
    pubkey: '26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958',
    id: '76c5977733a360c46c0e28548e2d06feb28292cdf53d0f0df0b8ad352ba3b654',
    sig: '5057c68f57d829758af5090beb86738bdd09679f0997995b6d7f2b012c3698ff0519f79f01d5b44704c393a145caea1f415908b486ba0d34359134386b9a4650',
  };

  const sampleFilter = {
    kinds: [1],
    authors: ['26bb2ebed6c552d670c804b0d655267b3c662b21e026d6e48ac93a6070530958'],
  };

  let messageHandler: MessageHandler;
  let responseCallback: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = new MessageHandler(mockStorage, mockSubscriptionManager);
    responseCallback = vi.fn();
    messageHandler.onResponse(responseCallback);
  });

  describe('message validation', () => {
    it('should handle invalid message format', () => {
      messageHandler.handleMessage('client1', 'not-an-array' as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid message format',
      ]);
    });

    it('should handle unknown message type', () => {
      messageHandler.handleMessage('client1', ['UNKNOWN'] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Unknown message type: UNKNOWN',
      ]);
    });

    it('should validate EVENT message format', () => {
      messageHandler.handleMessage('client1', ['EVENT'] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid EVENT message format',
      ]);
    });

    it('should validate REQ message format', () => {
      messageHandler.handleMessage('client1', ['REQ'] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid REQ message format',
      ]);
    });

    it('should validate REQ message subscriptionId', () => {
      messageHandler.handleMessage('client1', ['REQ', ''] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid REQ message: missing or invalid subscriptionId',
      ]);
    });

    it('should validate REQ message filters', () => {
      messageHandler.handleMessage('client1', ['REQ', 'sub1'] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid REQ message: filters must be a non-empty array',
      ]);
    });

    it('should validate CLOSE message format', () => {
      messageHandler.handleMessage('client1', ['CLOSE'] as unknown as NostrWireMessage);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid CLOSE message format',
      ]);
    });
  });

  describe('message processing', () => {
    describe('EVENT message', () => {
      it('should process valid EVENT message', async () => {
        const message: NostrWireMessage = ['EVENT', sampleEvent];
        await messageHandler.handleMessage('client1', message);

        expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: true });
        expect(responseCallback).toHaveBeenCalledWith('client1', ['OK', sampleEvent.id, true, '']);
      });

      it('should handle storage failure', async () => {
        (mockStorage.saveEvent as Mock).mockRejectedValueOnce(new Error('Storage error'));

        const message: NostrWireMessage = ['EVENT', sampleEvent];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'OK',
          sampleEvent.id,
          false,
          'error: storage operation failed',
        ]);
        expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: true });
      });

      it('should broadcast event to matching subscriptions', async () => {
        const subscriptions = new Map([['client2', [{ id: 'sub1', filters: [sampleFilter] }]]]);
        (mockSubscriptionManager.findMatchingSubscriptions as Mock).mockReturnValueOnce(
          subscriptions
        );

        const message: NostrWireMessage = ['EVENT', sampleEvent];
        await messageHandler.handleMessage('client1', message);

        // client2にイベントが送信されることを確認
        expect(responseCallback).toHaveBeenCalledWith('client2', ['EVENT', 'sub1', sampleEvent]);
      });

      describe('validateEventsType modes', () => {
        // A structurally-present but cryptographically invalid event
        const invalidEvent: NostrEvent = { ...sampleEvent, id: 'invalid-event', sig: 'deadbeef' };

        it('IMMEDIATELY (default): rejects an invalid event without storing it', async () => {
          await messageHandler.handleMessage('client1', ['EVENT', invalidEvent]);

          expect(mockStorage.saveEvent).not.toHaveBeenCalled();
          expect(responseCallback).toHaveBeenCalledWith('client1', [
            'OK',
            invalidEvent.id,
            false,
            'invalid: event validation failed',
          ]);
        });

        it('IMMEDIATELY: verifies a valid event exactly once (no duplicate verification)', async () => {
          // Regression guard: the EVENT path must not validate the signature
          // twice. EventHandler already validates synchronously in IMMEDIATELY
          // mode, so MessageHandler must not run its own pre-check on top.
          const validateSpy = vi.spyOn(EventValidator.prototype, 'validate');

          try {
            await messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);
            expect(validateSpy).toHaveBeenCalledTimes(1);
          } finally {
            // Restore even if the assertion throws, so the spy never leaks
            // into subsequent tests (no global restoreMocks is configured).
            validateSpy.mockRestore();
          }
        });

        it('LAZY: accepts and stores an invalid event as pending validation', async () => {
          const lazyHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'LAZY'
          );
          const cb = vi.fn();
          lazyHandler.onResponse(cb);

          await lazyHandler.handleMessage('client1', ['EVENT', invalidEvent]);

          // Stored as validated=false: the persistent queue (validated=0 rows)
          // is what the background validator drains later.
          expect(mockStorage.saveEvent).toHaveBeenCalledWith(invalidEvent, { validated: false });
          expect(cb).toHaveBeenCalledWith('client1', ['OK', invalidEvent.id, true, '']);
        });

        it('NONE: accepts and stores without validating, as unvalidated', async () => {
          const noneHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'NONE'
          );
          const cb = vi.fn();
          noneHandler.onResponse(cb);

          await noneHandler.handleMessage('client1', ['EVENT', invalidEvent]);

          expect(mockStorage.saveEvent).toHaveBeenCalledWith(invalidEvent, { validated: false });
          expect(cb).toHaveBeenCalledWith('client1', ['OK', invalidEvent.id, true, '']);
        });

        it('LAZY: validates ephemeral events synchronously and rejects invalid ones', async () => {
          // Ephemeral events are never stored, so lazy/background validation
          // can never check them; they must be validated up front even in LAZY.
          const lazyHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'LAZY'
          );
          const cb = vi.fn();
          lazyHandler.onResponse(cb);
          const invalidEphemeral: NostrEvent = {
            ...sampleEvent,
            id: 'invalid-ephemeral',
            kind: 20001,
            sig: 'deadbeef',
          };

          await lazyHandler.handleMessage('client1', ['EVENT', invalidEphemeral]);

          expect(cb).toHaveBeenCalledWith('client1', [
            'OK',
            'invalid-ephemeral',
            false,
            'invalid: event validation failed',
          ]);
          expect(mockStorage.saveEvent).not.toHaveBeenCalled();
        });

        it('enforces the storage limit after a stored transport EVENT', async () => {
          const boundedHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'IMMEDIATELY',
            100,
            'FIFO'
          );
          boundedHandler.onResponse(vi.fn());

          await boundedHandler.handleMessage('client1', ['EVENT', sampleEvent]);

          expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO');
        });

        it('does not let an enforceLimit failure break the OK/broadcast of a stored event', async () => {
          (mockStorage.enforceLimit as Mock).mockRejectedValueOnce(new Error('evict boom'));
          const subscriptions = new Map([['client2', [{ id: 'sub1', filters: [sampleFilter] }]]]);
          (mockSubscriptionManager.findMatchingSubscriptions as Mock).mockReturnValueOnce(
            subscriptions
          );
          const boundedHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'IMMEDIATELY',
            100,
            'FIFO'
          );
          const cb = vi.fn();
          boundedHandler.onResponse(cb);

          await boundedHandler.handleMessage('client1', ['EVENT', sampleEvent]);

          // Exactly one OK (true) — no double OK(false) from a swallowed eviction error
          const okCalls = cb.mock.calls.filter(([, wire]) => wire[0] === 'OK');
          expect(okCalls).toHaveLength(1);
          expect(okCalls[0][1]).toEqual(['OK', sampleEvent.id, true, '']);
          // Broadcast to the matching subscriber still happened
          expect(cb).toHaveBeenCalledWith('client2', ['EVENT', 'sub1', sampleEvent]);
        });

        it('LAZY: accepts unstorable events without persisting anything', async () => {
          const lazyHandler = new MessageHandler(
            mockStorage,
            mockSubscriptionManager,
            20,
            500,
            'LAZY'
          );
          const cb = vi.fn();
          lazyHandler.onResponse(cb);
          // Addressable (kind 30000-39999) without a `d` tag is not persisted;
          // nothing enters the pending-validation queue for it.
          const addressableNoDTag: NostrEvent = {
            ...sampleEvent,
            id: 'addr-no-d',
            kind: 30000,
            tags: [],
          };

          await lazyHandler.handleMessage('client1', ['EVENT', addressableNoDTag]);

          expect(cb).toHaveBeenCalledWith('client1', ['OK', 'addr-no-d', true, '']);
          expect(mockStorage.saveEvent).not.toHaveBeenCalled();
        });
      });
    });

    describe('REQ message', () => {
      it('should process valid REQ message', async () => {
        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await messageHandler.handleMessage('client1', message);

        expect(mockSubscriptionManager.createSubscription).toHaveBeenCalledWith('client1', 'sub1', [
          sampleFilter,
        ]);
        expect(mockStorage.getEvents).toHaveBeenCalledWith([sampleFilter]);
        expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
      });

      it('should send matching events', async () => {
        (mockStorage.getEvents as Mock).mockResolvedValueOnce([sampleEvent]);

        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', ['EVENT', 'sub1', sampleEvent]);
        expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
      });

      it('should cap to the newest maxEventsPerRequest events', async () => {
        const limitedHandler = new MessageHandler(mockStorage, mockSubscriptionManager, 20, 2);
        const limitedCallback = vi.fn();
        limitedHandler.onResponse(limitedCallback);

        // Returned in arbitrary (non-time) order to prove the cap sorts by recency
        const events: NostrEvent[] = [
          { ...sampleEvent, id: 'event-old', created_at: 100 },
          { ...sampleEvent, id: 'event-newest', created_at: 500 },
          { ...sampleEvent, id: 'event-mid', created_at: 300 },
          { ...sampleEvent, id: 'event-second', created_at: 400 },
        ];
        (mockStorage.getEvents as Mock).mockResolvedValueOnce(events);

        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await limitedHandler.handleMessage('client1', message);

        const sentEvents = limitedCallback.mock.calls
          .filter(([, wire]) => wire[0] === 'EVENT')
          .map(([, wire]) => (wire[2] as NostrEvent).id);
        // The two newest events are kept (newest first)
        expect(sentEvents).toEqual(['event-newest', 'event-second']);
        // EOSE is still sent after the truncated batch
        expect(limitedCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
      });

      it('should handle storage errors during event retrieval', async () => {
        (mockStorage.getEvents as Mock).mockRejectedValueOnce(new Error('Storage error'));

        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'NOTICE',
          'Failed to get events: storage error',
        ]);
      });
    });

    describe('CLOSE message', () => {
      it('should process valid CLOSE message', () => {
        const message: NostrWireMessage = ['CLOSE', 'sub1'];
        messageHandler.handleMessage('client1', message);

        expect(mockSubscriptionManager.removeSubscription).toHaveBeenCalledWith('client1', 'sub1');
        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'CLOSED',
          'sub1',
          'subscription closed',
        ]);
      });

      it('should handle non-existent subscription', () => {
        (mockSubscriptionManager.removeSubscription as Mock).mockReturnValueOnce(false);

        const message: NostrWireMessage = ['CLOSE', 'sub1'];
        messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'CLOSED',
          'sub1',
          'subscription closed',
        ]);
      });
    });
  });

  describe('response handling', () => {
    it('should send EVENT message', () => {
      messageHandler.sendEvent('client1', 'sub1', sampleEvent);
      expect(responseCallback).toHaveBeenCalledWith('client1', ['EVENT', 'sub1', sampleEvent]);
    });

    it('should send OK message', () => {
      messageHandler.sendOK('client1', '123', true, 'success');
      expect(responseCallback).toHaveBeenCalledWith('client1', ['OK', '123', true, 'success']);
    });

    it('should send EOSE message', () => {
      messageHandler.sendEOSE('client1', 'sub1');
      expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
    });

    it('should send CLOSED message', () => {
      messageHandler.sendClosed('client1', 'sub1', 'reason');
      expect(responseCallback).toHaveBeenCalledWith('client1', ['CLOSED', 'sub1', 'reason']);
    });

    it('should send NOTICE message', () => {
      messageHandler.sendNotice('client1', 'message');
      expect(responseCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
    });

    it('should handle multiple response callbacks', () => {
      const secondCallback = vi.fn();
      messageHandler.onResponse(secondCallback);

      messageHandler.sendNotice('client1', 'message');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
      expect(secondCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
    });
  });

  describe('error handling', () => {
    it('should handle global errors', async () => {
      // グローバルエラーハンドリングのテスト
      (mockStorage.saveEvent as Mock).mockImplementationOnce(() => {
        throw new Error('System internal error with sensitive details');
      });

      const message: NostrWireMessage = ['EVENT', sampleEvent];
      await messageHandler.handleMessage('client1', message);

      // 安全なエラーメッセージが返されることを確認
      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'OK',
        sampleEvent.id,
        false,
        'error: storage operation failed',
      ]);
    });

    it('should handle storage errors with safe error message', async () => {
      // ストレージエラー処理のテスト
      (mockStorage.getEvents as Mock).mockRejectedValueOnce(
        new Error('Database connection details exposed')
      );

      const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
      await messageHandler.handleMessage('client1', message);

      // 安全なエラーメッセージが返されることを確認
      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Failed to get events: storage error',
      ]);
    });

    it('should handle subscription manager errors with safe error message', () => {
      // サブスクリプション作成エラー処理のテスト
      (mockSubscriptionManager.createSubscription as Mock).mockImplementationOnce(() => {
        throw new Error('Subscription error with stack trace and internal details');
      });

      const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
      messageHandler.handleMessage('client1', message);

      // 安全なエラーメッセージが返されることを確認
      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Failed to create subscription: subscription error',
      ]);
    });

    it('should handle subscription close errors with safe error message', () => {
      // サブスクリプション削除エラー処理のテスト
      (mockSubscriptionManager.removeSubscription as Mock).mockImplementationOnce(() => {
        throw new Error('Database connection failure with credentials');
      });

      const message: NostrWireMessage = ['CLOSE', 'sub1'];
      messageHandler.handleMessage('client1', message);

      // 安全なエラーメッセージが返されることを確認
      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Failed to close subscription: Unknown error',
      ]);
    });

    it('should handle malformed event data', async () => {
      // An empty pubkey makes the real signature verification fail.
      const invalidEvent = {
        ...sampleEvent,
        pubkey: '', // Empty string
      } as NostrEvent;
      const message: NostrWireMessage = ['EVENT', invalidEvent];
      await messageHandler.handleMessage('client1', message);

      // エラーメッセージと共にOKレスポンスが送信されることを確認
      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'OK',
        sampleEvent.id,
        false,
        'invalid: event validation failed',
      ]);

      // バリデーションエラーの場合、イベントは保存されない
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });

    it('should handle malformed filter data', async () => {
      const invalidFilter = { kinds: [] } as Filter;
      const message: NostrWireMessage = ['REQ', 'sub1', invalidFilter];
      await messageHandler.handleMessage('client1', message);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid filter format in subscription sub1',
      ]);
      expect(mockSubscriptionManager.createSubscription).not.toHaveBeenCalled();
      expect(mockStorage.getEvents).not.toHaveBeenCalled();
    });
  });

  describe('upstream coordinator hooks', () => {
    // Minimal stand-in for UpstreamCoordinator; only the methods MessageHandler
    // calls are needed.
    function makeCoordinator() {
      return {
        publish: vi.fn(),
        openForSubscription: vi.fn(),
        closeForSubscription: vi.fn(),
        closeAllForClient: vi.fn(),
        markDelivered: vi.fn(),
        // Unused by MessageHandler but part of the type surface.
        start: vi.fn(),
        stop: vi.fn(),
      };
    }

    it('forwards accepted EVENTs upstream (write-through)', async () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);

      await messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);

      expect(responseCallback).toHaveBeenCalledWith('client1', ['OK', sampleEvent.id, true, '']);
      expect(coordinator.publish).toHaveBeenCalledWith(sampleEvent);
    });

    it('does not forward EVENTs that fail validation', async () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);
      const invalidEvent: NostrEvent = { ...sampleEvent, id: 'invalid-event', sig: 'deadbeef' };

      await messageHandler.handleMessage('client1', ['EVENT', invalidEvent]);

      expect(coordinator.publish).not.toHaveBeenCalled();
    });

    it('records locally-broadcast events so upstream echoes are deduped', async () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);
      const subscriptions = new Map([['client2', [{ id: 'sub1', filters: [sampleFilter] }]]]);
      (mockSubscriptionManager.findMatchingSubscriptions as Mock).mockReturnValueOnce(
        subscriptions
      );

      await messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);

      expect(responseCallback).toHaveBeenCalledWith('client2', ['EVENT', 'sub1', sampleEvent]);
      expect(coordinator.markDelivered).toHaveBeenCalledWith('client2', 'sub1', sampleEvent.id);
    });

    it('opens an upstream subscription on REQ and delegates EOSE to the coordinator', async () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);
      (mockStorage.getEvents as Mock).mockResolvedValueOnce([sampleEvent]);

      await messageHandler.handleMessage('client1', ['REQ', 'sub1', sampleFilter]);

      // Local events are still sent immediately.
      expect(responseCallback).toHaveBeenCalledWith('client1', ['EVENT', 'sub1', sampleEvent]);
      // But EOSE is NOT sent directly — the coordinator owns it now.
      expect(responseCallback).not.toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
      // The coordinator is handed the locally-sent ids for dedup.
      expect(coordinator.openForSubscription).toHaveBeenCalledWith(
        'client1',
        'sub1',
        [sampleFilter],
        [sampleEvent.id]
      );
    });

    it('closes the previous upstream sub when a REQ reuses a subscription id', async () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);

      await messageHandler.handleMessage('client1', ['REQ', 'sub1', sampleFilter]);

      expect(coordinator.closeForSubscription).toHaveBeenCalledWith('client1', 'sub1');
    });

    it('closes the upstream sub on CLOSE', () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);

      messageHandler.handleMessage('client1', ['CLOSE', 'sub1']);

      expect(coordinator.closeForSubscription).toHaveBeenCalledWith('client1', 'sub1');
    });

    it('handleClientDisconnect removes local subs and closes all upstream subs', () => {
      const coordinator = makeCoordinator();
      messageHandler.setUpstreamCoordinator(coordinator as never);

      messageHandler.handleClientDisconnect('client1');

      expect(mockSubscriptionManager.removeAllSubscriptions).toHaveBeenCalledWith('client1');
      expect(coordinator.closeAllForClient).toHaveBeenCalledWith('client1');
    });

    it('sends EOSE directly when no coordinator is set (opt-in unchanged)', async () => {
      await messageHandler.handleMessage('client1', ['REQ', 'sub1', sampleFilter]);
      expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
    });

    it('ingestUpstreamEvent stores without sending OK or broadcasting', async () => {
      const result = await messageHandler.ingestUpstreamEvent(sampleEvent);

      expect(result).toEqual({ success: true, stored: true });
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: true });
      // No OK / EVENT broadcast is emitted for a backfilled event.
      expect(responseCallback).not.toHaveBeenCalled();
    });

    it('ingestUpstreamEvent rejects an invalid event in IMMEDIATELY mode', async () => {
      const invalidEvent: NostrEvent = { ...sampleEvent, id: 'invalid-event', sig: 'deadbeef' };
      const result = await messageHandler.ingestUpstreamEvent(invalidEvent);

      expect(result).toEqual({ success: false, stored: false });
      expect(mockStorage.saveEvent).not.toHaveBeenCalled();
    });
  });
});
