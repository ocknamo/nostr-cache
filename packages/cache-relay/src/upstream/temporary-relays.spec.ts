import type { RxNostr } from 'rx-nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemporaryRelays, type TemporaryRelaysOptions } from './temporary-relays.js';

interface Listener<T> {
  next(value: T): void;
  subscribe(listener: (value: T) => void): {
    add(sub: { unsubscribe(): void }): void;
    unsubscribe(): void;
  };
}

function listener<T>(): Listener<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    next: (value) => {
      for (const fn of [...listeners]) {
        fn(value);
      }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      const added: Array<{ unsubscribe(): void }> = [];
      return {
        add: (sub) => added.push(sub),
        unsubscribe: () => {
          listeners.delete(fn);
          for (const sub of added) {
            sub.unsubscribe();
          }
        },
      };
    },
  };
}

/** 状態を流せて、送った REQ の id を覚えるだけの rx-nostr。 */
function stubClient() {
  const state = listener<{ state: string }>();
  const messages = listener<unknown>();
  const used: string[] = [];
  const client = {
    createConnectionStateObservable: () => state,
    createAllMessageObservable: () => messages,
    use: (req: { rxReqId: string }) => {
      used.push(req.rxReqId);
      return { subscribe: () => ({ unsubscribe() {} }) };
    },
    dispose: vi.fn(),
  };
  return { client, state, used };
}

function setup(options: Partial<TemporaryRelaysOptions> = {}) {
  const clients: ReturnType<typeof stubClient>[] = [];
  let offline = false;
  const temporary = new TemporaryRelays({
    maxRelays: 2,
    cooldown: 10_000,
    offlineRetryDelay: 1_000,
    createClient: () => {
      const stub = stubClient();
      clients.push(stub);
      return stub.client as unknown as RxNostr;
    },
    onEvent: vi.fn(),
    onEose: vi.fn(),
    onGaveUp: vi.fn(),
    isOffline: () => offline,
    ...options,
  });
  return {
    temporary,
    clients,
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TemporaryRelays', () => {
  it('waits again when the resend comes due a moment before the cooldown ends', () => {
    vi.useFakeTimers();
    const { temporary, clients } = setup();
    temporary.subscribe('up1.0', [{ kinds: [1] }], 'wss://r');
    clients[0].state.next({ state: 'error' });
    // タイマーが Date.now() より先に来る（実タイマーでは珍しくない）
    const now = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => now() - 1);

    vi.advanceTimersByTime(10_000);
    expect(clients).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(clients).toHaveLength(2);
    expect(clients[1].used).toEqual(['up1.0']);
  });

  it('waits out a cooldown a failed write started while the resend was pending', () => {
    vi.useFakeTimers();
    const { temporary, clients, setOffline } = setup();
    temporary.subscribe('up1.0', [{ kinds: [1] }], 'wss://r');
    setOffline(true);
    clients[0].state.next({ state: 'error' });
    setOffline(false);

    vi.advanceTimersByTime(500);
    temporary.coolDown('wss://r');
    vi.advanceTimersByTime(500);
    expect(clients).toHaveLength(1);
    vi.advanceTimersByTime(9_500);
    expect(clients).toHaveLength(2);
    expect(clients[1].used).toEqual(['up1.0']);
  });

  it('does not resend to a relay that rejected us', () => {
    vi.useFakeTimers();
    const { temporary, clients } = setup();
    temporary.subscribe('up1.0', [{ kinds: [1] }], 'wss://r');

    clients[0].state.next({ state: 'rejected' });
    vi.advanceTimersByTime(20_000);

    expect(clients).toHaveLength(1);
  });

  it('drops pending resends on stop', () => {
    vi.useFakeTimers();
    const { temporary, clients } = setup();
    temporary.subscribe('up1.0', [{ kinds: [1] }], 'wss://r');
    clients[0].state.next({ state: 'error' });

    temporary.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  describe('coolDown', () => {
    it('takes the relay out of the targets', () => {
      const { temporary } = setup();
      temporary.coolDown('wss://r');
      expect(temporary.canReach('wss://r')).toBe(false);
    });

    it('leaves alone a relay a read is still using', () => {
      const { temporary } = setup();
      temporary.subscribe('up1.0', [{ kinds: [1] }], 'wss://r');
      temporary.coolDown('wss://r');
      expect(temporary.canReach('wss://r')).toBe(true);
    });

    it('does nothing while we are offline ourselves', () => {
      const { temporary, setOffline } = setup();
      setOffline(true);
      temporary.coolDown('wss://r');
      expect(temporary.canReach('wss://r')).toBe(true);
    });
  });
});
