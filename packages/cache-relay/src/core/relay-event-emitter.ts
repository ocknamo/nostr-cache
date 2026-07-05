/**
 * Typed event emitter for {@link NostrCacheRelay}.
 *
 * A small hand-rolled emitter with per-event-name payload typing for the
 * relay's lifecycle / data events (`connect` / `disconnect` / `error` /
 * `event` / `eose`). Extracted so the relay class composes it rather than
 * inlining the listener bookkeeping.
 */

import type {
  NostrEvent,
  RelayConnectHandler,
  RelayDisconnectHandler,
  RelayEoseHandler,
  RelayErrorHandler,
  RelayEventHandler,
} from '@nostr-cache/shared';

/** Relay event names. */
export type RelayEventName = 'connect' | 'disconnect' | 'error' | 'event' | 'eose';

/** Any relay event listener. */
export type RelayEventListener =
  | RelayConnectHandler
  | RelayDisconnectHandler
  | RelayErrorHandler
  | RelayEventHandler
  | RelayEoseHandler;

/**
 * Registers listeners and dispatches typed relay events to them.
 */
export class RelayEventEmitter {
  private listeners: Map<string, RelayEventListener[]> = new Map();

  /**
   * Register an event listener.
   *
   * @param event Event type to listen for
   * @param callback Function to call when the event occurs
   */
  on(event: RelayEventName, callback: RelayEventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }

    this.listeners.get(event)?.push(callback);
  }

  /**
   * Remove an event listener.
   *
   * @param event Event type to remove listener for
   * @param callback Function to remove
   */
  off(event: RelayEventName, callback: RelayEventListener): void {
    const listeners = this.listeners.get(event);

    if (listeners) {
      const index = listeners.indexOf(callback);

      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit an event to the registered listeners.
   *
   * @param event Event type to emit
   * @param payload Data to pass to the listeners (an Error for `error`, a
   *   NostrEvent for `event`, the subscription ID for `eose`)
   */
  emit(event: 'connect' | 'disconnect'): void;
  emit(event: 'error', payload: Error): void;
  emit(event: 'event', payload: NostrEvent): void;
  emit(event: 'eose', payload: string): void;
  emit(event: RelayEventName, payload?: Error | NostrEvent | string): void {
    const listeners = this.listeners.get(event);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      switch (event) {
        case 'connect':
        case 'disconnect':
          (listener as RelayConnectHandler | RelayDisconnectHandler)();
          break;
        case 'error':
          (listener as RelayErrorHandler)(payload as Error);
          break;
        case 'event':
          (listener as RelayEventHandler)(payload as NostrEvent);
          break;
        case 'eose':
          (listener as RelayEoseHandler)(payload as string);
          break;
      }
    }
  }
}
