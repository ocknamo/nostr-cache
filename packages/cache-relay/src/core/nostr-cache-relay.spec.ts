/**
 * Tests for NostrCacheRelay
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { getRandomSecret } from '@nostr-cache/shared';
import { seckeySigner } from 'rx-nostr-crypto';
import { type Mock, vi } from 'vitest';
import { LazyValidator } from '../event/lazy-validator.js';
import { createMockStorage } from '../test/utils/mock-storage.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { NostrCacheRelay } from './nostr-cache-relay.js';

describe('NostrCacheRelay', () => {
  const mockStorage = createMockStorage({
    deleteExpired: vi.fn().mockResolvedValue(0),
    enforceLimit: vi.fn().mockResolvedValue(0),
  });

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

  /**
   * Sign a real NIP-09 deletion request. kind 5 is verified in every
   * validation mode, so these tests cannot use a hand-written signature.
   */
  async function signDeletionRequest(tags: string[][]): Promise<NostrEvent> {
    const signer = seckeySigner(getRandomSecret());
    return signer.signEvent({
      pubkey: await signer.getPublicKey(),
      created_at: 1742660714,
      kind: 5,
      tags,
      content: '',
    });
  }

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
    it('should validate and save the event as validated', async () => {
      await relay.publishEvent(sampleEvent);

      // Default mode is IMMEDIATELY: verified before save → persisted as validated
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: true });
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

    it('should apply a published deletion request (NIP-09)', async () => {
      // in-process の publishEvent は EventHandler を経由しないため、
      // transport 経由 EVENT と同じ削除適用がここにも必要
      const target = 'd'.repeat(64);
      const deletion = await signDeletionRequest([['e', target]]);

      await relay.publishEvent(deletion);

      // 同期検証を通ったので検証済みとして保存される
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(deletion, { validated: true });
      expect(mockStorage.deleteEventsByIdsForPubkey).toHaveBeenCalledWith(
        [target],
        deletion.pubkey
      );
    });

    it('should not apply a deletion request that failed to save', async () => {
      const deletion = await signDeletionRequest([['e', 'd'.repeat(64)]]);
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(false);

      await relay.publishEvent(deletion);

      expect(mockStorage.deleteEventsByIdsForPubkey).not.toHaveBeenCalled();
    });

    it.each(['LAZY', 'NONE'] as const)(
      'should verify a deletion request up front in %s mode',
      async (validateEventsType) => {
        // 削除は取り消せないため、検証を緩めたモードでも署名を必ず確認する
        const relaxedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
          validateEventsType,
        });
        const forged: NostrEvent = {
          ...(await signDeletionRequest([['e', 'd'.repeat(64)]])),
          sig: '0'.repeat(128),
        };

        const result = await relaxedRelay.publishEvent(forged);

        expect(result).toBe(false);
        expect(mockStorage.saveEvent).not.toHaveBeenCalled();
        expect(mockStorage.deleteEventsByIdsForPubkey).not.toHaveBeenCalled();
      }
    );

    it('should enforce the storage limit after a save when storageMaxSize is set', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
      });

      await boundedRelay.publishEvent(sampleEvent);

      expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', undefined);
    });

    it('should pass the normalized cachePriority (npub decoded to hex) to enforceLimit', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
        cachePriority: {
          // NIP-19 公式テストベクタ
          pubkeys: ['npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'],
          kinds: [0],
        },
      });

      await boundedRelay.publishEvent(sampleEvent);

      expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', {
        pubkeys: ['7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'],
        kinds: [0],
      });
    });

    it('should throw at construction time on an invalid cachePriority pubkey', () => {
      expect(
        () =>
          new NostrCacheRelay(mockStorage, mockTransport, {
            cachePriority: { pubkeys: ['npub1invalid'] },
          })
      ).toThrow(/npub1invalid/);
    });

    it('should apply setCachePriority (normalized) to subsequent evictions', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
      });

      boundedRelay.setCachePriority({
        // NIP-19 公式テストベクタ
        pubkeys: ['npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'],
        kinds: [0],
      });
      await boundedRelay.publishEvent(sampleEvent);

      expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', {
        pubkeys: ['7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'],
        kinds: [0],
      });
    });

    it('should clear the priority config when setCachePriority is called without rules', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
        cachePriority: { kinds: [0] },
      });

      boundedRelay.setCachePriority(undefined);
      await boundedRelay.publishEvent(sampleEvent);

      expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', undefined);
    });

    it('should keep the current config when setCachePriority input is invalid', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
        cachePriority: { kinds: [0] },
      });

      expect(() => boundedRelay.setCachePriority({ pubkeys: ['npub1invalid'] })).toThrow(
        /npub1invalid/
      );
      await boundedRelay.publishEvent(sampleEvent);

      // 例外時は反映されず、生成時の設定のまま
      expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', {
        pubkeys: [],
        kinds: [0],
      });
    });

    it('should apply setCachePriority to transport EVENT evictions', async () => {
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        storageMaxSize: 100,
        cacheStrategy: 'FIFO',
      });
      // relay が transport に登録したメッセージハンドラ（MessageHandler 経路）
      const onMessage = (mockTransport.onMessage as Mock).mock.calls.at(-1)?.[0];

      boundedRelay.setCachePriority({ kinds: [0] });
      onMessage('client1', ['EVENT', sampleEvent]);

      // transport 経由の退避（MessageHandler.ingestEvent）にも新設定が届くこと
      await vi.waitFor(() => {
        expect(mockStorage.enforceLimit).toHaveBeenCalledWith(100, 'FIFO', {
          pubkeys: [],
          kinds: [0],
        });
      });
    });

    it('should not enforce the storage limit when storageMaxSize is unset', async () => {
      await relay.publishEvent(sampleEvent);

      expect(mockStorage.enforceLimit).not.toHaveBeenCalled();
    });

    it('should not let an enforceLimit failure affect the save or notification', async () => {
      (mockStorage.enforceLimit as Mock).mockRejectedValueOnce(new Error('evict boom'));
      const boundedRelay = new NostrCacheRelay(mockStorage, mockTransport, { storageMaxSize: 1 });
      const eventHandler = vi.fn();
      boundedRelay.on('event', eventHandler);
      await boundedRelay.subscribe('sub1', [{ kinds: [1] }]);
      eventHandler.mockClear();

      const result = await boundedRelay.publishEvent(sampleEvent);

      // The save succeeded and the local subscriber was notified despite the
      // eviction failure.
      expect(result).toBe(true);
      expect(eventHandler).toHaveBeenCalledWith(sampleEvent);
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
      // Dispatch through the composed emitter to verify on/off delegate to it.
      relay['emitter'].emit('connect');

      expect(handler).toHaveBeenCalled();

      relay.off('connect', handler);
      handler.mockClear();

      relay['emitter'].emit('connect');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('lazy validation', () => {
    // Track prototype spies so we can restore only them — restoring all mocks
    // would wipe the shared mockStorage implementations.
    let spies: ReturnType<typeof vi.spyOn>[] = [];
    const spyOnLazy = (method: 'start' | 'stop') => {
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

    it('should save published events as unvalidated (pending) in LAZY mode', async () => {
      const lazyRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'LAZY',
      });

      const result = await lazyRelay.publishEvent(sampleEvent);

      // Accepted/saved without synchronous validation; the persisted
      // validated=false row is the background validator's queue entry
      expect(result).toBe(true);
      expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: false });
    });

    it('should save published events as unvalidated in NONE mode', async () => {
      const noneRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'NONE',
      });

      await noneRelay.publishEvent(sampleEvent);

      expect(mockStorage.saveEvent).toHaveBeenCalledWith(sampleEvent, { validated: false });
    });

    it('should not start a background validator unless validateEventsType is LAZY', async () => {
      const startSpy = spyOnLazy('start');
      const immediate = new NostrCacheRelay(mockStorage, mockTransport, {
        validateEventsType: 'NONE',
      });

      await immediate.connect();

      expect(startSpy).not.toHaveBeenCalled();
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

  describe('getValidationStatus', () => {
    it('should delegate to the storage adapter', async () => {
      const statuses = new Map([
        ['id-1', 'validated'],
        ['id-2', 'pending'],
        ['id-3', 'unknown'],
      ]);
      (mockStorage.getValidationStatus as Mock).mockResolvedValueOnce(statuses);

      const result = await relay.getValidationStatus(['id-1', 'id-2', 'id-3']);

      expect(mockStorage.getValidationStatus).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3']);
      expect(result).toBe(statuses);
    });
  });

  describe('upstream read/write-through', () => {
    // Records calls and lets the test fire onEvent/onEose.
    class MockPool {
      eventCb?: (subId: string, event: NostrEvent, relayUrl: string) => void;
      eoseCb?: (subId: string) => void;
      readonly opened: Array<{ subId: string; filters: Filter[] }> = [];
      readonly closed: string[] = [];
      readonly published: NostrEvent[] = [];
      started = false;
      stopped = false;
      async start(): Promise<void> {
        this.started = true;
      }
      async stop(): Promise<void> {
        this.stopped = true;
      }
      publish(event: NostrEvent): void {
        this.published.push(event);
      }
      openSubscription(subId: string, filters: Filter[]): void {
        this.opened.push({ subId, filters });
      }
      closeSubscription(subId: string): void {
        this.closed.push(subId);
      }
      onEvent(cb: (subId: string, event: NostrEvent, relayUrl: string) => void): void {
        this.eventCb = cb;
      }
      onEose(cb: (subId: string) => void): void {
        this.eoseCb = cb;
      }
      getConnectedCount(): number {
        return 1;
      }
      fireEose(): void {
        this.eoseCb?.(this.opened[this.opened.length - 1].subId);
      }
    }

    let pool: MockPool;
    let upstreamRelay: NostrCacheRelay;

    beforeEach(() => {
      pool = new MockPool();
      upstreamRelay = new NostrCacheRelay(mockStorage, mockTransport, { upstreamPool: pool });
    });

    it('starts the upstream pool on connect and stops it on disconnect', async () => {
      await upstreamRelay.connect();
      expect(pool.started).toBe(true);

      await upstreamRelay.disconnect();
      expect(pool.stopped).toBe(true);
    });

    it('forwards published events upstream (write-through)', async () => {
      await upstreamRelay.publishEvent(sampleEvent);
      expect(pool.published).toContainEqual(sampleEvent);
    });

    it('does not forward upstream when the event fails to save', async () => {
      (mockStorage.saveEvent as Mock).mockResolvedValueOnce(false);
      await upstreamRelay.publishEvent(sampleEvent);
      expect(pool.published).toHaveLength(0);
    });

    it('opens an upstream subscription and defers eose to the pool (read-through)', async () => {
      const eoseHandler = vi.fn();
      upstreamRelay.on('eose', eoseHandler);

      await upstreamRelay.subscribe('sub1', [sampleFilter]);

      // The upstream subscription is opened...
      expect(pool.opened).toHaveLength(1);
      expect(pool.opened[0].filters).toEqual([sampleFilter]);
      // ...and eose is NOT emitted until the pool reports its aggregated EOSE.
      expect(eoseHandler).not.toHaveBeenCalled();

      pool.fireEose();
      expect(eoseHandler).toHaveBeenCalledWith('sub1');
    });

    it('closes the upstream subscription on unsubscribe', async () => {
      await upstreamRelay.subscribe('sub1', [sampleFilter]);
      const subId = pool.opened[0].subId;
      upstreamRelay.unsubscribe('sub1');
      expect(pool.closed).toContain(subId);
    });

    it('does not create a coordinator without upstream config (opt-in)', async () => {
      // The default `relay` has no upstream configured: subscribe emits eose
      // synchronously, exactly as before this feature existed.
      const eoseHandler = vi.fn();
      relay.on('eose', eoseHandler);
      await relay.subscribe('sub1', [sampleFilter]);
      expect(eoseHandler).toHaveBeenCalledWith('sub1');
    });

    // in-process subscribe() は handleReqMessage とは別経路なので、鮮度ウィンドウが
    // 両方で同じ判断をすることを個別に押さえる
    describe('freshness window on the in-process subscribe() path', () => {
      const PROFILE_PUBKEY = sampleEvent.pubkey;
      const profileFilter: Filter = { kinds: [0], authors: [PROFILE_PUBKEY] };
      const profileEvent: NostrEvent = { ...sampleEvent, id: 'profile-1', kind: 0 };

      /** Relay whose cached profile is `cachedSecondsAgo` seconds old. */
      function relayWithWindow(cachedSecondsAgo: number): {
        relay: NostrCacheRelay;
        pool: MockPool;
        touchCachedAt: Mock;
      } {
        const touchCachedAt = vi.fn().mockResolvedValue(1);
        const storage = {
          ...mockStorage,
          getEvents: vi.fn().mockResolvedValue([profileEvent]),
          getCachedAt: vi
            .fn()
            .mockResolvedValue(new Map([[profileEvent.id, Date.now() - cachedSecondsAgo * 1000]])),
          touchCachedAt,
        } as unknown as StorageAdapter;
        const freshPool = new MockPool();
        return {
          relay: new NostrCacheRelay(storage, mockTransport, {
            upstreamPool: freshPool,
            upstreamFreshness: { 0: 3600 },
          }),
          pool: freshPool,
          touchCachedAt,
        };
      }

      it('skips the upstream subscription and emits eose itself when fresh', async () => {
        const { relay: freshRelay, pool: freshPool } = relayWithWindow(60);
        const eoseHandler = vi.fn();
        freshRelay.on('eose', eoseHandler);

        await freshRelay.subscribe('sub1', [profileFilter]);

        expect(freshPool.opened).toHaveLength(0);
        expect(eoseHandler).toHaveBeenCalledWith('sub1');
      });

      it('opens the upstream subscription when the window has expired', async () => {
        const { relay: staleRelay, pool: stalePool } = relayWithWindow(7200);
        const eoseHandler = vi.fn();
        staleRelay.on('eose', eoseHandler);

        await staleRelay.subscribe('sub1', [profileFilter]);

        expect(stalePool.opened).toHaveLength(1);
        expect(stalePool.opened[0].filters).toEqual([profileFilter]);
        // eose は従来どおり coordinator が発火する
        expect(eoseHandler).not.toHaveBeenCalled();
      });

      it('re-arms the window when the upstream echoes an already-delivered id', async () => {
        const { relay: staleRelay, pool: stalePool, touchCachedAt } = relayWithWindow(7200);
        await staleRelay.subscribe('sub1', [profileFilter]);

        // 上流が同じ id を返す（内容が変わっていない replaceable の典型ケース）
        stalePool.eventCb?.(stalePool.opened[0].subId, profileEvent, 'wss://upstream.example');

        expect(touchCachedAt).toHaveBeenCalledWith([profileEvent.id]);
      });
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

    it('should apply setCachePriority to subsequent sweeps', async () => {
      const ttlRelay = new NostrCacheRelay(mockStorage, mockTransport, {
        ttl: 100,
        ttlSweepInterval: 30,
      });

      await ttlRelay.connect();
      await vi.advanceTimersByTimeAsync(0);
      // 差し替え前は優先設定なし（1 引数）
      expect(mockStorage.deleteExpired).toHaveBeenLastCalledWith(expect.any(Number));

      ttlRelay.setCachePriority({ kinds: [0] });
      await vi.advanceTimersByTimeAsync(30_000);
      // 次回スイープ（ExpiryReaper 経路）から新設定が反映されること
      expect(mockStorage.deleteExpired).toHaveBeenLastCalledWith(expect.any(Number), {
        pubkeys: [],
        kinds: [0],
      });

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
