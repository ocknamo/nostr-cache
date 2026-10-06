/**
 * 上流プールの rx-nostr に宛先付きで送らせないのは、一時接続が閉じずに残り、以後の購読の
 * EOSE 集約がそれを待ってしまうため（rx-nostr 3.7 の `confirmOK` の不具合）。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { logger } from '@nostr-cache/shared';
import { relayKey } from '../upstream/temporary-relays.js';

export const DEFAULT_OUTBOX_PUBLISH_TIMEOUT = 10_000;
/** 1 件の書き込みの宛先（最大 30）が一度に開けること。 */
export const DEFAULT_MAX_OUTBOX_SOCKETS = 32;
/** 続けて書き込むと同じリレーへ送ることが多いので、しばらく閉じずに使い回す。 */
export const DEFAULT_OUTBOX_LINGER = 10_000;

export interface OutboxPublisherOptions {
  /** 接続まで、および 1 件の `OK` を待つ上限 (ms)。 */
  timeout?: number;
  maxSockets?: number;
  /** 最後の `OK` から閉じるまで (ms)。 */
  linger?: number;
  /** {@link UpstreamPoolOptions.webSocketFactory} と同じ理由で、接続のたびに評価する。 */
  webSocketFactory?: () => typeof WebSocket;
  /** 繋がらなかった（開く前に落ちた・時間切れ）。読み込みの宛先からも外すのに使う。 */
  onUnreachable?: (relay: string) => void;
}

interface Connection {
  socket: WebSocket;
  opened: boolean;
  /** 開くのを待っているイベント。 */
  queued: NostrEvent[];
  /** `OK` を待っているイベントと、その時間切れ。 */
  awaiting: Map<string, ReturnType<typeof setTimeout>>;
  timer?: ReturnType<typeof setTimeout>;
}

export class OutboxPublisher {
  private readonly connections = new Map<string, Connection>();
  /** 上限に達していて開けなかった送信。接続が空いたら順に流す。 */
  private readonly waiting: Array<{ relay: string; event: NostrEvent }> = [];
  private stopped = false;

  constructor(private readonly options: OutboxPublisherOptions = {}) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
    for (const relay of [...this.connections.keys()]) {
      this.close(relay);
    }
  }

  /** fire-and-forget。 */
  publish(event: NostrEvent, relays: string[]): void {
    for (const relay of new Set(relays.map(relayKey))) {
      this.send(relay, event);
    }
  }

  private send(relay: string, event: NostrEvent): void {
    if (this.stopped) {
      return;
    }
    const existing = this.connections.get(relay);
    if (existing) {
      if (existing.opened) {
        this.transmit(relay, existing, event);
      } else {
        existing.queued.push(event);
      }
      return;
    }
    if (this.connections.size >= (this.options.maxSockets ?? DEFAULT_MAX_OUTBOX_SOCKETS)) {
      this.waiting.push({ relay, event });
      return;
    }
    this.connect(relay, event);
  }

  private connect(relay: string, first: NostrEvent): void {
    let socket: WebSocket;
    try {
      const Ctor = (this.options.webSocketFactory ?? (() => globalThis.WebSocket))();
      socket = new Ctor(relay);
    } catch (error) {
      logger.debug(`Outbox ${relay}: could not connect:`, error);
      return;
    }
    const connection: Connection = { socket, opened: false, queued: [first], awaiting: new Map() };
    this.connections.set(relay, connection);
    connection.timer = setTimeout(() => this.drop(relay, connection), this.timeout());
    socket.addEventListener('open', () => {
      connection.opened = true;
      clearTimeout(connection.timer);
      for (const event of connection.queued.splice(0)) {
        this.transmit(relay, connection, event);
      }
    });
    socket.addEventListener('message', (message: MessageEvent) => {
      const id = okFor(message.data);
      if (id !== undefined) {
        this.settle(relay, connection, id);
      }
    });
    socket.addEventListener('error', () => this.drop(relay, connection));
    socket.addEventListener('close', () => this.drop(relay, connection));
  }

  private transmit(relay: string, connection: Connection, event: NostrEvent): void {
    clearTimeout(connection.timer);
    try {
      connection.socket.send(JSON.stringify(['EVENT', event]));
    } catch {
      this.drop(relay, connection);
      return;
    }
    if (!connection.awaiting.has(event.id)) {
      connection.awaiting.set(
        event.id,
        setTimeout(() => this.settle(relay, connection, event.id), this.timeout())
      );
    }
  }

  private settle(relay: string, connection: Connection, eventId: string): void {
    clearTimeout(connection.awaiting.get(eventId));
    connection.awaiting.delete(eventId);
    if (connection.awaiting.size === 0 && connection.queued.length === 0) {
      clearTimeout(connection.timer);
      connection.timer = setTimeout(
        () => this.close(relay),
        this.options.linger ?? DEFAULT_OUTBOX_LINGER
      );
    }
  }

  /** 開く前に落ちたなら繋がらなかったものとして知らせる。 */
  private drop(relay: string, connection: Connection): void {
    if (this.connections.get(relay) !== connection) {
      return;
    }
    if (!connection.opened) {
      this.options.onUnreachable?.(relay);
    }
    this.close(relay);
  }

  private close(relay: string): void {
    const connection = this.connections.get(relay);
    if (!connection) {
      return;
    }
    this.connections.delete(relay);
    clearTimeout(connection.timer);
    for (const timer of connection.awaiting.values()) {
      clearTimeout(timer);
    }
    connection.socket.close();
    this.drainWaiting();
  }

  private drainWaiting(): void {
    const max = this.options.maxSockets ?? DEFAULT_MAX_OUTBOX_SOCKETS;
    while (this.waiting.length > 0 && this.connections.size < max && !this.stopped) {
      const next = this.waiting.shift();
      if (next) {
        this.send(next.relay, next.event);
      }
    }
  }

  private timeout(): number {
    return this.options.timeout ?? DEFAULT_OUTBOX_PUBLISH_TIMEOUT;
  }
}

function okFor(data: unknown): string | undefined {
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    const frame = JSON.parse(data);
    return Array.isArray(frame) && frame[0] === 'OK' && typeof frame[1] === 'string'
      ? frame[1]
      : undefined;
  } catch {
    return undefined;
  }
}
