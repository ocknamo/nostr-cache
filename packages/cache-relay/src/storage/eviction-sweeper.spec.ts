/** Tests for EvictionSweeper */

import { logger } from '@nostr-cache/shared';
import { type Mock, vi } from 'vitest';
import { type MockStorage, createMockStorage } from '../test/utils/mock-storage.js';
import { EvictionSweeper } from './eviction-sweeper.js';
import type { StorageAdapter } from './storage-adapter.js';

describe('EvictionSweeper', () => {
  let storage: MockStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = createMockStorage({ enforceLimit: vi.fn().mockResolvedValue(0) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should evict down to 90% of maxSize once it is exceeded', async () => {
    (storage.count as Mock).mockResolvedValue(1001);
    (storage.enforceLimit as Mock).mockResolvedValue(101);
    const sweeper = new EvictionSweeper(storage, { maxSize: 1000, strategy: 'LRU' });

    const evicted = await sweeper.sweep();

    expect(storage.enforceLimit).toHaveBeenCalledWith(900, 'LRU', undefined);
    expect(evicted).toBe(101);
  });

  it('should only count while the store is within maxSize', async () => {
    (storage.count as Mock).mockResolvedValue(1000);
    const sweeper = new EvictionSweeper(storage, { maxSize: 1000 });

    expect(await sweeper.sweep()).toBe(0);
    expect(storage.enforceLimit).not.toHaveBeenCalled();
  });

  it('should never target below one event', async () => {
    (storage.count as Mock).mockResolvedValue(2);
    const sweeper = new EvictionSweeper(storage, { maxSize: 1 });

    await sweeper.sweep();

    // floor(1 * 0.9) は 0 で、enforceLimit がそれを「上限なし」と解釈してしまう
    expect(storage.enforceLimit).toHaveBeenCalledWith(1, undefined, undefined);
  });

  it('should be a no-op when maxSize is non-positive', async () => {
    (storage.count as Mock).mockResolvedValue(100);
    const sweeper = new EvictionSweeper(storage, { maxSize: 0 });

    expect(await sweeper.sweep()).toBe(0);
    expect(storage.count).not.toHaveBeenCalled();
  });

  it('should forward the cache priority config, and the one replaced via setPriority', async () => {
    (storage.count as Mock).mockResolvedValue(101);
    const priority = { pubkeys: ['a'.repeat(64)], kinds: [0] };
    const sweeper = new EvictionSweeper(storage, { maxSize: 100, priority });

    await sweeper.sweep();
    expect(storage.enforceLimit).toHaveBeenLastCalledWith(90, undefined, priority);

    const replaced = { pubkeys: [], kinds: [3] };
    sweeper.setPriority(replaced);
    await sweeper.sweep();
    expect(storage.enforceLimit).toHaveBeenLastCalledWith(90, undefined, replaced);
  });

  it('should warn (once) and no-op when storage lacks enforceLimit', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const unbounded = { ...storage, enforceLimit: undefined } as StorageAdapter;
    const sweeper = new EvictionSweeper(unbounded, { maxSize: 100 });

    expect(await sweeper.sweep()).toBe(0);
    expect(await sweeper.sweep()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('should hold the first sweep back past the boot burst, then run on the interval', async () => {
    (storage.count as Mock).mockResolvedValue(101);
    const sweeper = new EvictionSweeper(storage, {
      maxSize: 100,
      intervalSeconds: 60,
      initialDelaySeconds: 30,
    });

    sweeper.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(storage.enforceLimit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(storage.enforceLimit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.enforceLimit).toHaveBeenCalledTimes(2);

    sweeper.stop();
  });

  it('should stop sweeping after stop(), including before the first sweep', async () => {
    (storage.count as Mock).mockResolvedValue(101);
    const sweeper = new EvictionSweeper(storage, {
      maxSize: 100,
      intervalSeconds: 60,
      initialDelaySeconds: 30,
    });

    sweeper.start();
    sweeper.stop();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(storage.enforceLimit).not.toHaveBeenCalled();
  });

  it('should not overlap sweeps while one is in flight', async () => {
    (storage.count as Mock).mockResolvedValue(101);
    let resolveEvict: (n: number) => void = () => {};
    (storage.enforceLimit as Mock).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveEvict = resolve;
        })
    );
    const sweeper = new EvictionSweeper(storage, {
      maxSize: 100,
      intervalSeconds: 60,
      initialDelaySeconds: 0,
    });

    sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.enforceLimit).toHaveBeenCalledTimes(1);

    resolveEvict(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.enforceLimit).toHaveBeenCalledTimes(2);

    sweeper.stop();
  });

  it('should keep sweeping after a failed pass', async () => {
    (storage.count as Mock).mockResolvedValue(101);
    (storage.enforceLimit as Mock).mockRejectedValueOnce(new Error('evict boom'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const sweeper = new EvictionSweeper(storage, {
      maxSize: 100,
      intervalSeconds: 60,
      initialDelaySeconds: 0,
    });

    sweeper.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(storage.enforceLimit).toHaveBeenCalledTimes(2);
    sweeper.stop();
    errorSpy.mockRestore();
  });
});
