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
  /** In-memory stand-in for the persisted pending queue (validated=0 rows). */
  let pending: NostrEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    pending = [];
    storage = {
      saveEvent: vi.fn().mockResolvedValue(true),
      getEvents: vi.fn().mockResolvedValue([]),
      deleteEvent: vi.fn().mockImplementation((id: string) => {
        const before = pending.length;
        pending = pending.filter((event) => event.id !== id);
        return Promise.resolve(pending.length < before);
      }),
      clear: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
      deleteEventsByPubkeyAndKind: vi.fn().mockResolvedValue(true),
      deleteEventsByPubkeyKindAndDTag: vi.fn().mockResolvedValue(true),
      getUnvalidatedEvents: vi
        .fn()
        .mockImplementation((limit: number) => Promise.resolve(pending.slice(0, limit))),
      markValidated: vi.fn().mockImplementation((ids: string[]) => {
        pending = pending.filter((event) => !ids.includes(event.id));
        return Promise.resolve();
      }),
      getValidationStatus: vi.fn().mockResolvedValue(new Map()),
    } as StorageAdapter;
    validator = { validate: vi.fn().mockResolvedValue(true) } as unknown as EventValidator;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delete invalid events and mark valid ones in a pass', async () => {
    (validator.validate as Mock).mockImplementation((event: NostrEvent) =>
      Promise.resolve(event.id === 'valid')
    );
    const lv = new LazyValidator(storage, {}, validator);
    pending.push(makeEvent('valid'), makeEvent('invalid'));

    const { validated, removed } = await lv.processBatch();

    expect(validated).toBe(1);
    expect(removed).toBe(1);
    expect(storage.deleteEvent).toHaveBeenCalledTimes(1);
    expect(storage.deleteEvent).toHaveBeenCalledWith('invalid');
    expect(storage.markValidated).toHaveBeenCalledWith(['valid']);
  });

  it('should treat a validator that throws as invalid', async () => {
    (validator.validate as Mock).mockRejectedValue(new Error('boom'));
    const lv = new LazyValidator(storage, {}, validator);
    pending.push(makeEvent('boom'));

    const { validated, removed } = await lv.processBatch();

    expect(validated).toBe(0);
    expect(removed).toBe(1);
    expect(storage.deleteEvent).toHaveBeenCalledWith('boom');
    expect(storage.markValidated).not.toHaveBeenCalled();
  });

  it('should only process up to batchSize events per pass', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { batchSize: 2 }, validator);
    pending.push(makeEvent('a'), makeEvent('b'), makeEvent('c'));

    await lv.processBatch();

    expect(storage.getUnvalidatedEvents).toHaveBeenCalledWith(2);
    expect(storage.deleteEvent).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
  });

  it('should run an immediate pass on start() to resume pending work', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { intervalSeconds: 5 }, validator);
    // 前セッションから持ち越された未検証イベント（リロード復帰）
    pending.push(makeEvent('leftover'));

    lv.start();
    // No timer advance: the kick-off pass alone must pick it up
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.deleteEvent).toHaveBeenCalledWith('leftover');
    lv.stop();
  });

  it('should run processing on the configured interval after start()', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { intervalSeconds: 5 }, validator);

    lv.start();
    // Let the immediate kick-off pass finish on an empty queue first
    await vi.advanceTimersByTimeAsync(0);
    pending.push(makeEvent('x'));
    // Advance to trigger one interval tick, then flush the async pass
    await vi.advanceTimersByTimeAsync(5000);

    expect(storage.deleteEvent).toHaveBeenCalledWith('x');
    lv.stop();
  });

  it('should stop processing after stop()', async () => {
    (validator.validate as Mock).mockResolvedValue(false);
    const lv = new LazyValidator(storage, { intervalSeconds: 5 }, validator);
    lv.start();
    await vi.advanceTimersByTimeAsync(0);
    lv.stop();
    pending.push(makeEvent('y'));

    await vi.advanceTimersByTimeAsync(15000);

    expect(storage.deleteEvent).not.toHaveBeenCalled();
    // Still pending in storage; the next start() will resume it
    expect(pending).toHaveLength(1);
  });

  it('should fall back to defaults for non-positive options', async () => {
    const lv = new LazyValidator(storage, { intervalSeconds: 0, batchSize: -5 }, validator);

    await lv.processBatch();

    // Default batch size applied; nothing throws
    expect(storage.getUnvalidatedEvents).toHaveBeenCalledWith(100);
  });

  it('should leave valid events pending when markValidated fails', async () => {
    (storage.markValidated as Mock).mockRejectedValue(new Error('db down'));
    const lv = new LazyValidator(storage, {}, validator);
    pending.push(makeEvent('valid'));

    const { validated, removed } = await lv.processBatch();

    // Reported as not validated; the row stays pending for the next pass
    expect(validated).toBe(0);
    expect(removed).toBe(0);
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
    pending.push(makeEvent('slow'));

    lv.start();
    // The kick-off pass starts and is awaiting validation; two interval
    // ticks later it still has not resolved, so both ticks must be skipped
    await vi.advanceTimersByTimeAsync(2000);

    expect(validator.validate).toHaveBeenCalledTimes(1);

    // Let the in-flight pass finish
    resolveValidate(true);
    lv.stop();
  });
});
