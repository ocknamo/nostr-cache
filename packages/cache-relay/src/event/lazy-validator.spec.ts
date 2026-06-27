/**
 * Tests for LazyValidator
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { type Mock, vi } from 'vitest';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { EventValidator } from './event-validator.js';
import { LazyValidator } from './lazy-validator.js';

describe('LazyValidator', () => {
  const makeEvent = (id: string): NostrEvent => ({
    id,
    pubkey: 'pk',
    created_at: 1000,
    kind: 1,
    tags: [],
    content: '',
    sig: 'sig',
  });

  let storage: StorageAdapter;
  let validator: EventValidator;

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
    } as StorageAdapter;
    validator = { validate: vi.fn().mockResolvedValue(true) } as unknown as EventValidator;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delete invalid events and keep valid ones in a pass', async () => {
    (validator.validate as Mock).mockImplementation((event: NostrEvent) =>
      Promise.resolve(event.id === 'valid')
    );
    const lv = new LazyValidator(storage, {}, validator);
    lv.enqueue(makeEvent('valid'));
    lv.enqueue(makeEvent('invalid'));

    const removed = await lv.processBatch();

    expect(removed).toBe(1);
    expect(storage.deleteEvent).toHaveBeenCalledTimes(1);
    expect(storage.deleteEvent).toHaveBeenCalledWith('invalid');
  });

  it('should treat a validator that throws as invalid', async () => {
    (validator.validate as Mock).mockRejectedValue(new Error('boom'));
    const lv = new LazyValidator(storage, {}, validator);
    lv.enqueue(makeEvent('boom'));

    const removed = await lv.processBatch();

    expect(removed).toBe(1);
    expect(storage.deleteEvent).toHaveBeenCalledWith('boom');
  });

  it('should only process up to batchSize events per pass', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { batchSize: 2 }, validator);
    lv.enqueue(makeEvent('a'));
    lv.enqueue(makeEvent('b'));
    lv.enqueue(makeEvent('c'));

    await lv.processBatch();

    expect(storage.deleteEvent).toHaveBeenCalledTimes(2);
    expect(lv.pendingCount).toBe(1);
  });

  it('should run processing on the configured interval after start()', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { intervalSeconds: 5 }, validator);
    lv.enqueue(makeEvent('x'));

    lv.start();
    // Advance to trigger one interval tick, then flush the async pass
    await vi.advanceTimersByTimeAsync(5000);

    expect(storage.deleteEvent).toHaveBeenCalledWith('x');
    lv.stop();
  });

  it('should stop processing after stop()', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { intervalSeconds: 5 }, validator);
    lv.start();
    lv.stop();
    lv.enqueue(makeEvent('y'));

    await vi.advanceTimersByTimeAsync(15000);

    expect(storage.deleteEvent).not.toHaveBeenCalled();
    expect(lv.pendingCount).toBe(1);
  });

  it('should fall back to defaults for non-positive options', () => {
    const lv = new LazyValidator(
      storage,
      { intervalSeconds: 0, batchSize: -5, maxQueueSize: 0 },
      validator
    );
    // Defaults applied; nothing throws and queue starts empty
    expect(lv.pendingCount).toBe(0);
  });

  it('should drop the oldest event when the queue exceeds maxQueueSize', () => {
    const lv = new LazyValidator(storage, { maxQueueSize: 2 }, validator);
    lv.enqueue(makeEvent('a'));
    lv.enqueue(makeEvent('b'));
    lv.enqueue(makeEvent('c'));

    // Queue is capped at 2; the oldest ('a') was dropped
    expect(lv.pendingCount).toBe(2);
  });

  it('should validate and drain the entire queue on flush', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { batchSize: 2 }, validator);
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      lv.enqueue(makeEvent(id));
    }

    const removed = await lv.flush();

    expect(removed).toBe(5);
    expect(lv.pendingCount).toBe(0);
    expect(storage.deleteEvent).toHaveBeenCalledTimes(5);
  });

  it('should not overlap passes when a previous pass is still running', async () => {
    let resolveValidate: (value: boolean) => void = () => {};
    (validator.validate as Mock).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveValidate = resolve;
        })
    );
    const lv = new LazyValidator(storage, { intervalSeconds: 1 }, validator);
    lv.enqueue(makeEvent('slow'));

    lv.start();
    // First tick starts a pass that is awaiting validation
    await vi.advanceTimersByTimeAsync(1000);
    // Second tick should be skipped because the first pass has not resolved
    await vi.advanceTimersByTimeAsync(1000);

    expect(validator.validate).toHaveBeenCalledTimes(1);

    // Let the in-flight pass finish
    resolveValidate(true);
    lv.stop();
  });
});
