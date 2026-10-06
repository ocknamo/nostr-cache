/**
 * 上流プールの rx-nostr に宛先付きで送らせないのは、一時接続が閉じずに残り、以後の購読の
 * EOSE 集約がそれを待ってしまうため（rx-nostr 3.7 の `confirmOK` の不具合）。
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { logger } from '@nostr-cache/shared';

export const DEFAULT_OUTBOX_PUBLISH_TIMEOUT = 10_000;

export interface OutboxPublisherOptions {
  /** 接続を含めて 1 リレーの `OK` を待つ上限 (ms)。 */
  timeout?: number;
  /** {@link UpstreamPoolOptions.webSocketFactory} と同じ理由で、送るたびに評価する。 */
  webSocketFactory?: () => typeof WebSocket;
}

export class OutboxPublisher {
  private readonly sockets = new Set<WebSocket>();
  private stopped = false;

  constructor(private readonly options: OutboxPublisherOptions = {}) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
  }

  /** fire-and-forget。`OK` を受けるか上限に達したら接続を閉じる。 */
  publish(event: NostrEvent, relays: string[]): void {
    for (const relay of relays) {
      if (this.stopped) {
        return;
      }
      this.sendTo(relay, event);
    }
  }

  private sendTo(relay: string, event: NostrEvent): void {
    let socket: WebSocket;
    try {
      const Ctor = (this.options.webSocketFactory ?? (() => globalThis.WebSocket))();
      socket = new Ctor(relay);
    } catch (error) {
      logger.debug(`Outbox ${relay}: could not connect:`, error);
      return;
    }
    this.sockets.add(socket);
    const finish = () => {
      clearTimeout(timer);
      if (this.sockets.delete(socket)) {
        socket.close();
      }
    };
    const timer = setTimeout(finish, this.options.timeout ?? DEFAULT_OUTBOX_PUBLISH_TIMEOUT);
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify(['EVENT', event]));
      } catch {
        finish();
      }
    });
    socket.addEventListener('message', (message: MessageEvent) => {
      if (isOkFor(message.data, event.id)) {
        finish();
      }
    });
    socket.addEventListener('error', finish);
    socket.addEventListener('close', finish);
  }
}

function isOkFor(data: unknown, eventId: string): boolean {
  if (typeof data !== 'string') {
    return false;
  }
  try {
    const frame = JSON.parse(data);
    return Array.isArray(frame) && frame[0] === 'OK' && frame[1] === eventId;
  } catch {
    return false;
  }
}
