/**
 * Tests for the typed relay event emitter.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { vi } from 'vitest';
import { RelayEventEmitter } from './relay-event-emitter.js';

const sampleEvent = { id: 'e1', kind: 1 } as NostrEvent;

describe('RelayEventEmitter', () => {
  it('dispatches to a registered listener', () => {
    const emitter = new RelayEventEmitter();
    const handler = vi.fn();
    emitter.on('connect', handler);

    emitter.emit('connect');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes the typed payload for each event kind', () => {
    const emitter = new RelayEventEmitter();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const onEose = vi.fn();
    emitter.on('error', onError);
    emitter.on('event', onEvent);
    emitter.on('eose', onEose);

    const err = new Error('boom');
    emitter.emit('error', err);
    emitter.emit('event', sampleEvent);
    emitter.emit('eose', 'sub1');

    expect(onError).toHaveBeenCalledWith(err);
    expect(onEvent).toHaveBeenCalledWith(sampleEvent);
    expect(onEose).toHaveBeenCalledWith('sub1');
  });

  it('invokes multiple listeners in registration order', () => {
    const emitter = new RelayEventEmitter();
    const calls: number[] = [];
    emitter.on('connect', () => calls.push(1));
    emitter.on('connect', () => calls.push(2));

    emitter.emit('connect');

    expect(calls).toEqual([1, 2]);
  });

  it('stops dispatching to a removed listener', () => {
    const emitter = new RelayEventEmitter();
    const handler = vi.fn();
    emitter.on('connect', handler);
    emitter.off('connect', handler);

    emitter.emit('connect');

    expect(handler).not.toHaveBeenCalled();
  });

  it('only removes the given listener, leaving others registered', () => {
    const emitter = new RelayEventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('connect', a);
    emitter.on('connect', b);

    emitter.off('connect', a);
    emitter.emit('connect');

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('is a no-op to emit an event with no listeners', () => {
    const emitter = new RelayEventEmitter();
    expect(() => emitter.emit('connect')).not.toThrow();
  });
});
