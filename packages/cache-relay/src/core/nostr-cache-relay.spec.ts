/**
 * Tests for NostrCacheRelay
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { type Mock, vi } from 'vitest';
import { LazyValidator } from '../event/lazy-validator.js';
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
    count: vi.fn().mockResolvedValue(0),
    deleteExpired: vi.fn().mockResolvedValue(0),
  };

  // Mock transport adapter
  const mockTransport: TransportAdapter = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onMessage: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    getConnectionCount: vi.fn().mockReturnValue(0),
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
        validateEventsType: 'NONE',
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
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(true);

      const result = await relay.publishEvent(sampleEvent);

      expect(result).toBe(true);
    });

    it('should return false if the event was not saved', async () => {
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(false);

      const result = await relay.publishEvent(sampleEvent);

      expect(result).toBe(false);
    });
  });

  describe('publishEvent notifications', () => {
    it('should emit a matching event to local subscribers', async () => {
      const eventHandler = vi.fn();
      relay.on('event', eventHandler);

      await relay.subscribe('sub1', [{ kinds: [1] }]);
      // Ignore any replay during subscribe; assert only the publish-driven emit
      eventHandler.mockClear();
      await relay.publishEvent(sampleEvent);

      expect(eventHandler).toHaveBeenCalledWith(sampleEvent);
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    it('should not emit an event that no subscriber matches', async () => {
      const eventHandler = vi.fn();
      relay.on('event', eventHandler);

      await relay.subscribe('sub1', [{ kinds: [9999] }]);
      // EOSE replay aside, the published event should not be delivered
      eventHandler.mockClear();
      await relay.publishEvent(sampleEvent);

      expect(eventHandler).not.toHaveBeenCalled();
    });

    it('should not emit when the event fails to save', async () => {
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(false);
      const eventHandler = vi.fn();
      relay.on('event', eventHandler);

      await relay.subscribe('sub1', [{ kinds: [1] }]);
      eventHandler.mockClear();
      await relay.publishEvent(sampleEvent);

      expect(eventHandler).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('should replay stored events and then emit eose', async () => {
      (mockStorage.getEvents as Mock).mockResolvedValueOnce([sampleEvent]);
      const eventHandler = vi.fn();
      const eoseHandler = vi.fn();
      relay.on('event', eventHandler);
      relay.on('eose', eoseHandler);

      await relay.subscribe('sub1', [sampleFilter]);

      expect(mockStorage.getEvents).toHaveBeenCalledWith([sampleFilter]);
      expect(eventHandler).toHaveBeenCalledWith(sampleEvent);
      expect(eoseHandler).toHaveBeenCalledWith('sub1');
    });

    it('should emit eose even when there are no stored events', async () => {
      const eoseHandler = vi.fn();
      relay.on('eose', eoseHandler);

      await relay.subscribe('sub1', [sampleFilter]);

      expect(eoseHandler).toHaveBeenCalledWith('sub1');
    });

    it('should cap replayed events to the newest maxEventsPerRequest', async () => {
      const cappedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        maxEventsPerRequest: 2,
      });
      const events = [
        { ...sampleEvent, id: 'event-old', created_at: 100 },
        { ...sampleEvent, id: 'event-newest', created_at: 500 },
        { ...sampleEvent, id: 'event-mid', created_at: 300 },
        { ...sampleEvent, id: 'event-second', created_at: 400 },
      ];
      (mockStorage.getEvents as Mock).mockResolvedValueOnce(events);
      const eventHandler = vi.fn();
      const eoseHandler = vi.fn();
      cappedRelay.on('event', eventHandler);
      cappedRelay.on('eose', eoseHandler);

      await cappedRelay.subscribe('sub1', [sampleFilter]);

      const replayedIds = eventHandler.mock.calls.map(([event]) => (event as NostrEvent).id);
      expect(replayedIds).toEqual(['event-newest', 'event-second']);
      expect(eoseHandler).toHaveBeenCalledWith('sub1');
    });
  });

  describe('unsubscribe', () => {
    it('should return true when removing an existing subscription', async () => {
      await relay.subscribe('sub1', [sampleFilter]);

      expect(relay.unsubscribe('sub1')).toBe(true);
    });

    it('should return false for an unknown subscription', () => {
      expect(relay.unsubscribe('non-existent')).toBe(false);
    });

    it('should stop delivering events after unsubscribe', async () => {
      const eventHandler = vi.fn();
      relay.on('event', eventHandler);

      await relay.subscribe('sub1', [{ kinds: [1] }]);
      relay.unsubscribe('sub1');
      eventHandler.mockClear();

      await relay.publishEvent(sampleEvent);

      expect(eventHandler).not.toHaveBeenCalled();
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

  describe('lazy validation', () => {
    // Track prototype spies so we can restore only them — restoring all mocks
    // would wipe the shared mockStorage implementations.
    let spies: ReturnType<typeof vi.spyOn>[] = [];
    const spyOnLazy = (method: 'enqueue' | 'start' | 'stop' | 'flush') => {
      const spy = vi.spyOn(LazyValidator.prototype, method);
      spies.push(spy);
      return spy;
    };

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
      spies = [];
    });

    it('should not create a lazy validator unless validateEventsType is LAZY', async () => {
      const enqueueSpy = spyOnLazy('enqueue');
      const immediate = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'NONE',
      });

      // No lazy validator is wired, so publishing never enqueues
      await immediate.publishEvent(sampleEvent);
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should enqueue saved events for background validation in LAZY mode', async () => {
      const enqueueSpy = spyOnLazy('enqueue');
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      const result = await lazyRelay.publishEvent(sampleEvent);

      // Event is accepted/saved without synchronous validation, then enqueued
      expect(result).toBe(true);
      expect(enqueueSpy).toHaveBeenCalledWith(sampleEvent);
    });

    it('should not enqueue when the event fails to save in LAZY mode', async () => {
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(false);
      const enqueueSpy = spyOnLazy('enqueue');
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      await lazyRelay.publishEvent(sampleEvent);

      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('should start and stop the background validator on connect/disconnect', async () => {
      const startSpy = spyOnLazy('start');
      const stopSpy = spyOnLazy('stop');
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      await lazyRelay.connect();
      expect(startSpy).toHaveBeenCalledTimes(1);

      await lazyRelay.disconnect();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('should flush the pending queue on disconnect', async () => {
      const flushSpy = spyOnLazy('flush').mockResolvedValue(0);
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      await lazyRelay.connect();
      await lazyRelay.disconnect();

      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('should keep a single background validator across repeated connects', async () => {
      const startSpy = spyOnLazy('start');
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      await lazyRelay.connect();
      await lazyRelay.connect();

      // start() is idempotent (guards its own timer), so repeated connects are safe
      expect(startSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('ttl background sweep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not sweep when ttl is not configured', async () => {
      await relay.connect();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockStorage.deleteExpired).not.toHaveBeenCalled();
    });

    it('should purge expired events from storage on connect and on the interval', async () => {
      const ttlRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        ttl: 100,
        ttlSweepInterval: 30,
      });

      await ttlRelay.connect();
      // Immediate sweep on start, flushed by the async timer helper
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStorage.deleteExpired).toHaveBeenCalledTimes(1);

      // Subsequent sweeps run on the configured interval
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockStorage.deleteExpired).toHaveBeenCalledTimes(2);

      // Each sweep deletes everything older than now - ttl
      const now = Math.floor(Date.now() / 1000);
      const [[threshold]] = (mockStorage.deleteExpired as Mock).mock.calls;
      expect(threshold).toBeLessThanOrEqual(now - 100);

      await ttlRelay.disconnect();
    });

    it('should stop sweeping after disconnect', async () => {
      const ttlRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        ttl: 100,
        ttlSweepInterval: 30,
      });

      await ttlRelay.connect();
      await vi.advanceTimersByTimeAsync(0);
      await ttlRelay.disconnect();
      (mockStorage.deleteExpired as Mock).mockClear();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockStorage.deleteExpired).not.toHaveBeenCalled();
    });
  });
});
