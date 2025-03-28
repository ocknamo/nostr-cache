/**
 * Tests for MessageHandler
 */

import type { Filter, NostrEvent, NostrWireMessage } from '@nostr-cache/types';
import { type Mock, vi } from 'vitest';
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
    getSubscriptionKey: vi
      .fn()
      .mockImplementation((clientId, subscriptionId) => `${clientId}:${subscriptionId}`),
  } as unknown as SubscriptionManager;

  // // Mock event validator
  const mockEventValidator = {
    validate: vi.fn().mockResolvedValue(true),
  };

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

        expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent);
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
        expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent);
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
      const mockEventValidator = {
        validate: vi.fn().mockResolvedValueOnce(false),
      };
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
});
