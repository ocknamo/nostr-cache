/** インデックスリレーへのワンショット問い合わせ。接続の寿命管理は rx-nostr が持つ。 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { LazyFilter, RxNostr } from 'rx-nostr';
import { createRxBackwardReq, createRxNostr } from 'rx-nostr';

export const DEFAULT_INDEX_EOSE_TIMEOUT = 5000;

export interface IndexFetchResult {
  events: NostrEvent[];
  answered: number;
}

export interface IndexRelayClientOptions {
  /** 接続後、各リレーの EOSE を待つ上限 (ms)。全体の上限はその 2 倍。 */
  eoseTimeout?: number;
  /** {@link UpstreamPoolOptions.webSocketFactory} と同じ理由で、接続時に 1 回評価する。 */
  webSocketFactory?: () => typeof WebSocket;
}

export class IndexRelayClient {
  private rxNostr?: RxNostr;
  private stopped = false;
  private sequence = 0;

  constructor(
    private readonly urls: string[],
    private readonly options: IndexRelayClientOptions = {}
  ) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.rxNostr?.dispose();
    this.rxNostr = undefined;
  }

  /**
   * 全リレーの答えを重複排除せずに返す。reject しない代わりに、EOSE を返したリレーの数を
   * 添える（0 なら「誰も答えなかった」で、「誰も持っていない」とは区別される）。
   */
  fetch(filter: Filter): Promise<IndexFetchResult> {
    const rxNostr = this.connect();
    if (!rxNostr) {
      return Promise.resolve({ events: [], answered: 0 });
    }
    const timeout = this.options.eoseTimeout ?? DEFAULT_INDEX_EOSE_TIMEOUT;
    this.sequence += 1;
    const reqId = `idx${this.sequence}`;
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const answered = new Set<string>();
      const req = createRxBackwardReq(reqId);
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(guard);
        // complete から同期で呼ばれうるので、subscribe() が返るのを待ってから外す
        queueMicrotask(() => {
          subscription.unsubscribe();
          eoses.unsubscribe();
        });
        resolve({ events, answered: answered.size });
      };
      // rx-nostr の EOSE タイムアウトは接続後の REQ から数えるので、繋がらないリレーを
      // 待ち続けないよう全体にも上限を掛ける
      const guard = setTimeout(finish, timeout * 2);
      // backward のワイヤ上の id は `${reqId}:${n}`
      const eoses = rxNostr.createAllMessageObservable().subscribe((packet) => {
        if (packet.type === 'EOSE' && packet.subId.startsWith(`${reqId}:`)) {
          answered.add(packet.from);
        }
      });
      const subscription = rxNostr.use(req).subscribe({
        next: ({ event }) => {
          events.push(event as NostrEvent);
        },
        complete: finish,
        error: finish,
      });
      req.emit(filter as LazyFilter);
      req.over();
    });
  }

  private connect(): RxNostr | undefined {
    if (this.stopped) {
      return undefined;
    }
    if (this.rxNostr) {
      return this.rxNostr;
    }
    this.rxNostr = createRxNostr({
      // 検証は取り込み側（ingest）が持つ
      skipVerify: true,
      skipExpirationCheck: true,
      skipFetchNip11: true,
      // 問い合わせは散発的なので、使わない間は接続を畳む
      connectionStrategy: 'lazy',
      eoseTimeout: this.options.eoseTimeout ?? DEFAULT_INDEX_EOSE_TIMEOUT,
      websocketCtor: (this.options.webSocketFactory ?? (() => globalThis.WebSocket))(),
    });
    this.rxNostr.setDefaultRelays(this.urls);
    return this.rxNostr;
  }
}
