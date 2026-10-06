import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FakeWebSocket, createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { OutboxPublisher } from './outbox-publisher.js';

const event = (id: string): NostrEvent => ({
  id,
  pubkey: 'p',
  created_at: 0,
  kind: 1,
  tags: [],
  content: '',
  sig: '',
});

function setup(options: { timeout?: number; linger?: number; maxSockets?: number } = {}) {
  const fake = createFakeWebSocketFactory();
  const onUnreachable = vi.fn();
  const publisher = new OutboxPublisher({
    webSocketFactory: fake.factory,
    timeout: 1000,
    linger: 500,
    onUnreachable,
    ...options,
  });
  const socket = (url: string) => fake.forUrl(url) as FakeWebSocket;
  return { publisher, fake, socket, onUnreachable };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxPublisher', () => {
  it('sends once the socket opens, then keeps it a while after the OK', () => {
    vi.useFakeTimers();
    const { publisher, socket } = setup();

    publisher.publish(event('e1'), ['wss://a/', 'wss://b']);
    socket('wss://a').mockOpen();
    socket('wss://a').mockMessage(['OK', 'other', true, '']);
    socket('wss://a').mockMessage(['OK', 'e1', true, '']);

    expect(socket('wss://a').sent).toEqual([['EVENT', event('e1')]]);
    expect(socket('wss://a').readyState).toBe(1);
    vi.advanceTimersByTime(500);
    expect(socket('wss://a').readyState).toBe(3);
  });

  it('reuses an open or opening socket for the next event to the same relay', () => {
    vi.useFakeTimers();
    const { publisher, fake, socket } = setup();

    publisher.publish(event('e1'), ['wss://a']);
    publisher.publish(event('e2'), ['wss://a']);
    socket('wss://a').mockOpen();
    socket('wss://a').mockMessage(['OK', 'e1', true, '']);
    publisher.publish(event('e3'), ['wss://a']);

    expect(fake.sockets).toHaveLength(1);
    expect(socket('wss://a').sent).toEqual([
      ['EVENT', event('e1')],
      ['EVENT', event('e2')],
      ['EVENT', event('e3')],
    ]);
    // e2 / e3 の OK を待っている間は閉じない
    vi.advanceTimersByTime(500);
    expect(socket('wss://a').readyState).toBe(1);
  });

  it('reports a relay that drops or times out before opening as unreachable', () => {
    vi.useFakeTimers();
    const { publisher, socket, onUnreachable } = setup();

    publisher.publish(event('e1'), ['wss://refused', 'wss://silent', 'wss://picky']);
    socket('wss://refused').close();
    socket('wss://picky').mockOpen();
    socket('wss://picky').close();
    vi.advanceTimersByTime(1000);

    expect(onUnreachable.mock.calls.map(([relay]) => relay).sort()).toEqual([
      'wss://refused',
      'wss://silent',
    ]);
    expect(socket('wss://silent').readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a free socket when at the cap', () => {
    vi.useFakeTimers();
    const { publisher, fake, socket } = setup({ maxSockets: 1 });

    publisher.publish(event('e1'), ['wss://a', 'wss://b']);
    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://a']);

    socket('wss://a').mockOpen();
    socket('wss://a').mockMessage(['OK', 'e1', true, '']);
    vi.advanceTimersByTime(500);

    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://a', 'wss://b']);
  });

  it('skips a relay whose socket cannot be constructed and still sends to the rest', () => {
    const fake = createFakeWebSocketFactory();
    const publisher = new OutboxPublisher({
      webSocketFactory: () => {
        const Ctor = fake.factory();
        return class extends (Ctor as unknown as new (url: string) => WebSocket) {
          constructor(url: string) {
            if (url === 'wss://bad') {
              throw new SyntaxError('bad url');
            }
            super(url);
          }
        } as unknown as typeof WebSocket;
      },
    });

    publisher.publish(event('e1'), ['wss://bad', 'wss://good']);

    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://good']);
  });

  it('closes what is still open on stop, and connects nowhere afterwards', () => {
    vi.useFakeTimers();
    const { publisher, fake, socket } = setup();
    publisher.publish(event('e1'), ['wss://a']);

    publisher.stop();
    publisher.publish(event('e2'), ['wss://b']);

    expect(socket('wss://a').readyState).toBe(3);
    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://a']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
