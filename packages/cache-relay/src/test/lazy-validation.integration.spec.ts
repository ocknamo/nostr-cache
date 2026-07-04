/**
 * Integration test: persistent lazy validation (reload resume)
 *
 * The lazy-validation queue is the storage itself (`validated` column), so
 * events left unvalidated by a previous session — e.g. the process was killed
 * before the background pass ran — must be picked up and validated by the
 * next session over the same database.
 */

import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { NostrCacheRelay } from '../core/nostr-cache-relay.js';
import { DexieStorage } from '../storage/dexie-storage.js';
import type { TransportAdapter } from '../transport/transport-adapter.js';
import { createTestEvent } from './utils/base.integration.js';

/** Minimal in-memory transport; these tests use the in-process relay API only. */
function createNoopTransport(): TransportAdapter {
  return {
    start: async () => {},
    stop: async () => {},
    send: () => {},
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    getConnectionCount: () => 0,
  };
}

describe('Lazy validation persistence integration', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = `LazyValidationIntegration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    const cleanup = new DexieStorage(dbName);
    await cleanup.delete();
    // Reset indexedDB for next test
    // @ts-ignore - fake-indexeddb types
    // biome-ignore lint/suspicious/noGlobalAssign: for indexedDB mock
    indexedDB = new IDBFactory();
  });

  it('resumes validation of pending events after a reload', async () => {
    const validEvent = await createTestEvent();
    const signedEvent = await createTestEvent();
    // Tampered content invalidates the id/signature
    const forgedEvent = { ...signedEvent, content: 'tampered content' };

    // --- Session 1: LAZY relay accepts both events, then "crashes" before
    // any validation pass runs (no connect, so the timer never starts).
    const storage1 = new DexieStorage(dbName);
    const relay1 = new NostrCacheRelay(storage1, createNoopTransport(), {
      validateEventsType: 'LAZY',
    });

    expect(await relay1.publishEvent(validEvent)).toBe(true);
    expect(await relay1.publishEvent(forgedEvent)).toBe(true);

    // Both are stored and pending — nothing has been verified yet
    const pendingStatuses = await relay1.getValidationStatus([validEvent.id, forgedEvent.id]);
    expect(pendingStatuses.get(validEvent.id)).toBe('pending');
    expect(pendingStatuses.get(forgedEvent.id)).toBe('pending');

    storage1.close();

    // --- Session 2: a fresh relay over the same database. connect() kicks an
    // immediate validation pass that drains the persisted pending queue.
    const storage2 = new DexieStorage(dbName);
    const relay2 = new NostrCacheRelay(storage2, createNoopTransport(), {
      validateEventsType: 'LAZY',
    });
    await relay2.connect();

    await vi.waitFor(async () => {
      const statuses = await relay2.getValidationStatus([validEvent.id, forgedEvent.id]);
      // The valid event is verified and marked; the forged one is deleted
      expect(statuses.get(validEvent.id)).toBe('validated');
      expect(statuses.get(forgedEvent.id)).toBe('unknown');
    });

    // The forged event is really gone from storage
    const remaining = await storage2.getEvents([{ ids: [validEvent.id, forgedEvent.id] }]);
    expect(remaining.map((event) => event.id)).toEqual([validEvent.id]);

    await relay2.disconnect();
    storage2.close();
  });

  it('persists validated status across sessions (no re-validation needed)', async () => {
    const validEvent = await createTestEvent();

    // --- Session 1: validate the event, then shut down cleanly.
    // Publish before connect so the kick-off pass on connect picks it up
    // (the next timer pass would otherwise be a full interval away).
    const storage1 = new DexieStorage(dbName);
    const relay1 = new NostrCacheRelay(storage1, createNoopTransport(), {
      validateEventsType: 'LAZY',
    });
    await relay1.publishEvent(validEvent);
    await relay1.connect();

    await vi.waitFor(async () => {
      const statuses = await relay1.getValidationStatus([validEvent.id]);
      expect(statuses.get(validEvent.id)).toBe('validated');
    });

    await relay1.disconnect();
    storage1.close();

    // --- Session 2: the persisted result is visible immediately, before any
    // validation pass — this is what lets clients skip their own verification
    const storage2 = new DexieStorage(dbName);
    const relay2 = new NostrCacheRelay(storage2, createNoopTransport(), {
      validateEventsType: 'LAZY',
    });

    const statuses = await relay2.getValidationStatus([validEvent.id]);
    expect(statuses.get(validEvent.id)).toBe('validated');
    // And it is no longer part of the pending queue
    expect(await storage2.getUnvalidatedEvents(10)).toEqual([]);

    storage2.close();
  });
});
