/**
 * Tests for MessageHandler
 */

import { Filter, NostrEvent, NostrWireMessage } from '@nostr-cache/types';
import { EventValidator } from '../event/EventValidator';
import { StorageAdapter } from '../storage/StorageAdapter';
import { MessageHandler } from './MessageHandler';
import { SubscriptionManager } from './SubscriptionManager';

describe('MessageHandler', () => {
  // Mock storage adapter
  const mockStorage = {
    saveEvent: jest.fn().mockResolvedValue(true),
    getEvents: jest.fn().mockResolvedValue([]),
    deleteEvent: jest.fn().mockResolvedValue(true),
    clear: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<StorageAdapter>;

  // Mock subscription manager
  const mockSubscriptionManager = {
    subscriptions: new Map(),
    clientSubscriptions: new Map(),
    storage: mockStorage,
    createSubscription: jest.fn(),
    removeSubscription: jest.fn(),
    removeAllSubscriptions: jest.fn(),
    removeSubscriptionByIdForAllClients: jest.fn(),
    getSubscription: jest.fn(),
    getClientSubscriptions: jest.fn(),
    getAllSubscriptions: jest.fn(),
    findMatchingSubscriptions: jest.fn().mockReturnValue(new Map()),
    eventMatchesFilter: jest.fn().mockReturnValue(true),
    getSubscriptionKey: jest
      .fn()
      .mockImplementation((clientId, subscriptionId) => `${clientId}:${subscriptionId}`),
  } as unknown as SubscriptionManager;

  // // Mock event validator
  const mockEventValidator = {
    validate: jest.fn().mockResolvedValue(true),
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
  let responseCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    messageHandler = new MessageHandler(mockStorage, mockSubscriptionManager);
    responseCallback = jest.fn();
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
        mockStorage.saveEvent.mockRejectedValueOnce(new Error('Storage error'));

        const message: NostrWireMessage = ['EVENT', sampleEvent];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'OK',
          sampleEvent.id,
          false,
          'error: failed to save event',
        ]);
        expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent);
      });

      it('should broadcast event to matching subscriptions', async () => {
        const subscriptions = new Map([['client2', [{ id: 'sub1', filters: [sampleFilter] }]]]);
        (mockSubscriptionManager.findMatchingSubscriptions as jest.Mock).mockReturnValueOnce(
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
        (mockStorage.getEvents as jest.Mock).mockResolvedValueOnce([sampleEvent]);

        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', ['EVENT', 'sub1', sampleEvent]);
        expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
      });

      it('should handle storage errors during event retrieval', async () => {
        (mockStorage.getEvents as jest.Mock).mockRejectedValueOnce(new Error('Storage error'));

        const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
        await messageHandler.handleMessage('client1', message);

        expect(responseCallback).toHaveBeenCalledWith('client1', [
          'NOTICE',
          'Failed to get events: Error: Storage error',
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
        (mockSubscriptionManager.removeSubscription as jest.Mock).mockReturnValueOnce(false);

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
      const secondCallback = jest.fn();
      messageHandler.onResponse(secondCallback);

      messageHandler.sendNotice('client1', 'message');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
      expect(secondCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
    });
  });

  describe('error handling', () => {
    it('should handle subscription manager errors', () => {
      (mockSubscriptionManager.createSubscription as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Subscription error');
      });

      const message: NostrWireMessage = ['REQ', 'sub1', sampleFilter];
      messageHandler.handleMessage('client1', message);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Failed to create subscription: Error: Subscription error',
      ]);
    });

    it('should handle malformed event data', async () => {
      const mockEventValidator = {
        validate: jest.fn().mockResolvedValueOnce(false),
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
