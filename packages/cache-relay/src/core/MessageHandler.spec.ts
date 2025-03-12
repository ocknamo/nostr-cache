/**
 * Tests for MessageHandler
 */

import { NostrEvent } from '@nostr-cache/types';
import { EventValidator } from '../event/EventValidator';
import { MessageHandler } from './MessageHandler';

describe('MessageHandler', () => {
  // Mock event validator
  const mockEventValidator: EventValidator = {
    validate: jest.fn().mockReturnValue(true),
  };

  // Sample event
  const sampleEvent: NostrEvent = {
    id: '123',
    pubkey: 'abc',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Hello, world!',
    sig: 'xyz',
  };

  let messageHandler: MessageHandler;
  let responseCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    messageHandler = new MessageHandler(mockEventValidator);
    responseCallback = jest.fn();
    messageHandler.onResponse(responseCallback);
  });

  describe('handleMessage', () => {
    it('should handle invalid message format', () => {
      messageHandler.handleMessage('client1', 'not-an-array' as any);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid message format',
      ]);
    });

    it('should handle unknown message type', () => {
      messageHandler.handleMessage('client1', ['UNKNOWN']);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Unknown message type: UNKNOWN',
      ]);
    });
  });

  describe('handleEventMessage', () => {
    it('should handle invalid EVENT message format', () => {
      messageHandler.handleMessage('client1', ['EVENT']);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid EVENT message format',
      ]);
    });

    it('should validate the event', () => {
      messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);

      expect(mockEventValidator.validate).toHaveBeenCalledWith(sampleEvent);
    });

    it('should send OK message if event is valid', () => {
      (mockEventValidator.validate as jest.Mock).mockReturnValueOnce(true);

      messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);

      expect(responseCallback).toHaveBeenCalledWith('client1', ['OK', sampleEvent.id, true, '']);
    });

    it('should send OK message with error if event is invalid', () => {
      (mockEventValidator.validate as jest.Mock).mockReturnValueOnce(false);

      messageHandler.handleMessage('client1', ['EVENT', sampleEvent]);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'OK',
        sampleEvent.id,
        false,
        'invalid: event validation failed',
      ]);
    });
  });

  describe('handleReqMessage', () => {
    it('should handle invalid REQ message format', () => {
      messageHandler.handleMessage('client1', ['REQ']);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid REQ message format',
      ]);
    });

    it('should send EOSE message', () => {
      messageHandler.handleMessage('client1', ['REQ', 'sub1', { kinds: [1] }]);

      expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
    });
  });

  describe('handleCloseMessage', () => {
    it('should handle invalid CLOSE message format', () => {
      messageHandler.handleMessage('client1', ['CLOSE']);

      expect(responseCallback).toHaveBeenCalledWith('client1', [
        'NOTICE',
        'Invalid CLOSE message format',
      ]);
    });

    it('should log the close', () => {
      const consoleSpy = jest.spyOn(console, 'log');

      messageHandler.handleMessage('client1', ['CLOSE', 'sub1']);

      expect(consoleSpy).toHaveBeenCalledWith('Client client1 closed subscription sub1');
    });
  });

  describe('sendEvent', () => {
    it('should send EVENT message', () => {
      messageHandler.sendEvent('client1', 'sub1', sampleEvent);

      expect(responseCallback).toHaveBeenCalledWith('client1', ['EVENT', 'sub1', sampleEvent]);
    });
  });

  describe('sendOK', () => {
    it('should send OK message', () => {
      messageHandler.sendOK('client1', '123', true, '');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['OK', '123', true, '']);
    });
  });

  describe('sendEOSE', () => {
    it('should send EOSE message', () => {
      messageHandler.sendEOSE('client1', 'sub1');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['EOSE', 'sub1']);
    });
  });

  describe('sendClosed', () => {
    it('should send CLOSED message', () => {
      messageHandler.sendClosed('client1', 'sub1', 'reason');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['CLOSED', 'sub1', 'reason']);
    });
  });

  describe('sendNotice', () => {
    it('should send NOTICE message', () => {
      messageHandler.sendNotice('client1', 'message');

      expect(responseCallback).toHaveBeenCalledWith('client1', ['NOTICE', 'message']);
    });
  });
});
