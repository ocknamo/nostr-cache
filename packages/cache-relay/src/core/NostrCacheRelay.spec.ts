/**
 * Tests for NostrCacheRelay
 */

import { Filter, NostrEvent } from '@nostr-cache/types';
import { StorageAdapter } from '../storage/StorageAdapter';
import { TransportAdapter } from '../transport/TransportAdapter';
import { NostrCacheRelay } from './NostrCacheRelay';

describe('NostrCacheRelay', () => {
  // Mock storage adapter
  const mockStorage: StorageAdapter = {
    saveEvent: jest.fn().mockResolvedValue(true),
    getEvents: jest.fn().mockResolvedValue([]),
    deleteEvent: jest.fn().mockResolvedValue(true),
    clear: jest.fn().mockResolvedValue(undefined),
    deleteEventsByPubkeyAndKind: jest.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: jest.fn().mockResolvedValue(true),
  };

  // Mock transport adapter
  const mockTransport: TransportAdapter = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    send: jest.fn(),
    onMessage: jest.fn(),
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
  };

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

  // Sample filter
  const sampleFilter: Filter = {
    kinds: [1],
    limit: 10,
  };

  let relay: NostrCacheRelay;

  beforeEach(() => {
    jest.clearAllMocks();
    relay = new NostrCacheRelay(mockStorage, mockTransport, {});
  });

  describe('constructor', () => {
    it('should create a relay with default options', () => {
      expect(relay).toBeDefined();
    });

    it('should create a relay with custom options', () => {
      const customRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEvents: false,
        maxSubscriptions: 50,
        maxEventsPerRequest: 200,
      });

      expect(customRelay).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should start the transport', async () => {
      await relay.connect();

      expect(mockTransport.start).toHaveBeenCalled();
    });

    it('should emit a connect event', async () => {
      const connectHandler = jest.fn();
      relay.on('connect', connectHandler);

      await relay.connect();

      expect(connectHandler).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should stop the transport', async () => {
      await relay.disconnect();

      expect(mockTransport.stop).toHaveBeenCalled();
    });

    it('should emit a disconnect event', async () => {
      const disconnectHandler = jest.fn();
      relay.on('disconnect', disconnectHandler);

      await relay.disconnect();

      expect(disconnectHandler).toHaveBeenCalled();
    });
  });

  describe('publishEvent', () => {
    it('should validate and save the event', async () => {
      await relay.publishEvent(sampleEvent);

      expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent);
    });

    it('should return true if the event was saved', async () => {
      (mockStorage.saveEvent as jest.Mock).mockResolvedValueOnce(true);

      const result = await relay.publishEvent(sampleEvent);

      expect(result).toBe(true);
    });

    it('should return false if the event was not saved', async () => {
      (mockStorage.saveEvent as jest.Mock).mockResolvedValueOnce(false);

      const result = await relay.publishEvent(sampleEvent);

      expect(result).toBe(false);
    });
  });

  describe('event listeners', () => {
    it('should add and remove event listeners', () => {
      const handler = jest.fn();

      relay.on('connect', handler);
      relay['emit']('connect');

      expect(handler).toHaveBeenCalled();

      relay.off('connect', handler);
      handler.mockClear();

      relay['emit']('connect');

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
