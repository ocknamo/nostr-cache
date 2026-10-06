import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FakeWebSocket, createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { OutboxPublisher } from './outbox-publisher.js';

const EVENT: NostrEvent = {
  id: 'e1',
  pubkey: 'p',
  created_at: 0,
  kind: 1,
  tags: [],
  content: '',
  sig: '',
};

function setup(timeout = 1000) {
  const fake = createFakeWebSocketFactory();
  const publisher = new OutboxPublisher({ webSocketFactory: fake.factory, timeout });
  const socket = (url: string) => fake.forUrl(url) as FakeWebSocket;
  return { publisher, fake, socket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxPublisher', () => {
  it('sends the event once each socket opens, and closes it on the OK', () => {
    const { publisher, socket } = setup();

    publisher.publish(EVENT, ['wss://a', 'wss://b']);
    socket('wss://a').mockOpen();
    socket('wss://b').mockOpen();
    socket('wss://a').mockMessage(['NOTICE', 'hi']);
    socket('wss://a').mockMessage(['OK', 'other', true, '']);

    expect(socket('wss://a').sent).toEqual([['EVENT', EVENT]]);
    expect(socket('wss://b').sent).toEqual([['EVENT', EVENT]]);
    expect(socket('wss://a').readyState).toBe(1);

    socket('wss://a').mockMessage(['OK', 'e1', false, 'blocked']);

    expect(socket('wss://a').readyState).toBe(3);
    expect(socket('wss://b').readyState).toBe(1);
  });

  it('gives up on a relay that does not answer in time', () => {
    vi.useFakeTimers();
    const { publisher, socket } = setup(500);

    publisher.publish(EVENT, ['wss://slow']);
    vi.advanceTimersByTime(499);
    expect(socket('wss://slow').readyState).not.toBe(3);

    vi.advanceTimersByTime(1);
    expect(socket('wss://slow').readyState).toBe(3);
  });

  it('lets go of a socket the relay drops before answering, leaving no timer behind', () => {
    vi.useFakeTimers();
    const { publisher, socket } = setup();

    publisher.publish(EVENT, ['wss://a']);
    socket('wss://a').mockOpen();
    socket('wss://a').close();

    expect(vi.getTimerCount()).toBe(0);
    // 閉じた後に OK が届いても何も起きない
    expect(() => socket('wss://a').mockMessage(['OK', 'e1', true, ''])).not.toThrow();
  });

  it('clears the timeout once the OK arrives', () => {
    vi.useFakeTimers();
    const { publisher, socket } = setup();

    publisher.publish(EVENT, ['wss://a']);
    socket('wss://a').mockOpen();
    socket('wss://a').mockMessage(['OK', 'e1', true, '']);

    expect(vi.getTimerCount()).toBe(0);
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

    publisher.publish(EVENT, ['wss://bad', 'wss://good']);

    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://good']);
  });

  it('closes what is still open on stop, and connects nowhere afterwards', () => {
    const { publisher, fake, socket } = setup();
    publisher.publish(EVENT, ['wss://a']);

    publisher.stop();
    publisher.publish(EVENT, ['wss://b']);

    expect(socket('wss://a').readyState).toBe(3);
    expect(fake.sockets.map((s) => s.url)).toEqual(['wss://a']);
  });
});
