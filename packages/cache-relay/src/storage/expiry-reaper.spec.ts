/**
 * Tests for ExpiryReaper
 */

import { logger } from '@nostr-cache/shared';
import { type Mock, vi } from 'vitest';
import { ExpiryReaper } from './expiry-reaper.js';
import type { StorageAdapter } from './storage-adapter.js';

describe('ExpiryReaper', () => {
  let storage: StorageAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = {
      saveEvent: vi.fn().mockResolvedValue(true),
      getEvents: vi.fn().mockResolvedValue([]),
      deleteEvent: vi.fn().mockResolvedValue(true),
      clear: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
      deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
      deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
      deleteExpired: vi.fn().mockResolvedValue(0),
      getUnvalidatedEvents: vi.fn().mockResolvedValue([]),
      markValidated: vi.fn().mockResolvedValue(undefined),
      getValidationStatus: vi.fn().mockResolvedValue(new Map()),
    } as StorageAdapter;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delete events older than now - ttl on sweep', async () => {
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 100, now: () => 1000 });

    const removed = await reaper.sweep();

    expect(storage.deleteExpired).toHaveBeenCalledWith(900);
    expect(removed).toBe(0);
  });

  it('should be a no-op when ttl is non-positive', async () => {
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 0, now: () => 1000 });

    const removed = await reaper.sweep();

    expect(storage.deleteExpired).not.toHaveBeenCalled();
    expect(removed).toBe(0);
  });

  it('should warn (once) and no-op when storage lacks deleteExpired', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const noExpiry = { ...storage, deleteExpired: undefined } as StorageAdapter;
    const reaper = new ExpiryReaper(noExpiry, { ttlSeconds: 100 });

    expect(await reaper.sweep()).toBe(0);
    expect(await reaper.sweep()).toBe(0);
    // Warning is emitted only once across repeated sweeps
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('should not sweep again after stop() even if a sweep was in flight', async () => {
    let resolveDelete: (n: number) => void = () => {};
    (storage.deleteExpired as Mock).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 100, intervalSeconds: 10 });

    reaper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.deleteExpired).toHaveBeenCalledTimes(1);

    // Stop while the first sweep is still pending, then let it resolve
    reaper.stop();
    resolveDelete(0);
    await vi.advanceTimersByTimeAsync(60_000);

    // No further sweeps are scheduled after stop()
    expect(storage.deleteExpired).toHaveBeenCalledTimes(1);
  });

  it('should run an immediate sweep on start and then on the interval', async () => {
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 100, intervalSeconds: 10 });

    reaper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.deleteExpired).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.deleteExpired).toHaveBeenCalledTimes(2);

    reaper.stop();
  });

  it('should stop sweeping after stop()', async () => {
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 100, intervalSeconds: 10 });

    reaper.start();
    await vi.advanceTimersByTimeAsync(0);
    reaper.stop();
    (storage.deleteExpired as Mock).mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.deleteExpired).not.toHaveBeenCalled();
  });

  it('should not overlap sweeps while one is in flight', async () => {
    let resolveDelete: (n: number) => void = () => {};
    (storage.deleteExpired as Mock).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const reaper = new ExpiryReaper(storage, { ttlSeconds: 100, intervalSeconds: 10 });

    reaper.start();
    await vi.advanceTimersByTimeAsync(0);
    // The first sweep is still pending; the next tick must be skipped
    await vi.advanceTimersByTimeAsync(10_000);

    expect(storage.deleteExpired).toHaveBeenCalledTimes(1);

    resolveDelete(0);
    reaper.stop();
  });
});
