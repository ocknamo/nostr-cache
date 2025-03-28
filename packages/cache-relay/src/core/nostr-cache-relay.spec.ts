/**
 * Tests for NostrCacheRelay
 */

import type { Filter, NostrEvent } from '@nostr-cache/types';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi, type Mock } from 'vitest';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { NostrCacheRelay } from './nostr-cache-relay.js';

describe('NostrCacheRelay', () => {
  // Mock storage adapter
  const mockStorage: StorageAdapter = {
    saveEvent: vi.fn().mockResolvedValue(true),
    getEvents: vi.fn().mockResolvedValue([]),
    deleteEvent: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
    deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
  };

  // Mock transport adapter
  const mockTransport: TransportAdapter = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onMessage: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
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
    vi.clearAllMocks();
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
      const connectHandler = vi.fn();
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
      const disconnectHandler = vi.fn();
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
      const handler = vi.fn();

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
