/**
 * 宛先付きの購読が使う一時接続。リレーごとに専用の rx-nostr を持ち、落ちたら捨てて作り直す。
 * rx-nostr は既定リレー以外を張り直さないため（doc/cache-relay/upstream.md 第2.1節）。
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { LazyFilter, RxNostr } from 'rx-nostr';
import { createRxForwardReq } from 'rx-nostr';

/** rx-nostr の forward strategy はワイヤ上の購読 id を `${rxReqId}:0` にする。 */
const WIRE_SUB_ID_SUFFIX = ':0';

export function fromWireSubId(wireSubId: string): string | undefined {
  return wireSubId.endsWith(WIRE_SUB_ID_SUFFIX)
    ? wireSubId.slice(0, -WIRE_SUB_ID_SUFFIX.length)
    : undefined;
}

/** 同じリレーを別の綴りで数えないための鍵。 */
export function relayKey(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    u.hostname = u.hostname.replace(/\.$/, '');
    u.searchParams.sort();
    const s = u.toString();
    return u.search ? s : s.replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

export interface TemporaryRelaysOptions {
  maxRelays: number;
  /** 落ちたリレーを宛先にしない時間 (ms)。 */
  cooldown: number;
  /** 自分側の断線で落ちたとき、冷却の代わりに繋ぎ直すまで待つ時間 (ms)。 */
  offlineRetryDelay: number;
  /** そのリレーだけを既定リレーにした rx-nostr を作る。 */
  createClient: (relay: string) => RxNostr;
  onEvent: (upstreamSubId: string, event: NostrEvent, relay: string) => void;
  onEose: (upstreamSubId: string, relay: string) => void;
  /** 再試行を使い切った・拒まれた。そのリレーの EOSE はもう来ない。 */
  onGaveUp: (relay: string) => void;
  /** 自分側が繋がっていないか。そのとき落ちた宛先は相手のせいではないので冷却しない。 */
  isOffline: () => boolean;
}

interface Client {
  rxNostr: RxNostr;
  streams: { unsubscribe(): void };
  /** このリレーで開いている購読の数。0 のものは枠を数えず、溢れたら捨ててよい。 */
  open: number;
}

export class TemporaryRelays {
  private readonly clients = new Map<string, Client>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: TemporaryRelaysOptions) {}

  canReach(relay: string): boolean {
    const key = relayKey(relay);
    const until = this.cooldownUntil.get(key);
    if (until !== undefined) {
      if (Date.now() < until) {
        return false;
      }
      this.cooldownUntil.delete(key);
    }
    return (this.clients.get(key)?.open ?? 0) > 0 || this.inUse() < this.options.maxRelays;
  }

  /** 返した `unsubscribe` が CLOSE を送る。 */
  subscribe(
    upstreamSubId: string,
    filters: Filter[],
    relay: string
  ): { unsubscribe(): void } | undefined {
    const key = relayKey(relay);
    if (!this.canReach(key)) {
      return undefined;
    }
    const client = this.clientFor(key);
    client.open += 1;
    const req = createRxForwardReq(upstreamSubId);
    // Subscribe before emitting: the request stream is hot.
    const events = client.rxNostr.use(req).subscribe(({ event }) => {
      this.options.onEvent(upstreamSubId, event as NostrEvent, key);
    });
    req.emit(filters as LazyFilter[]);
    let closed = false;
    return {
      unsubscribe: () => {
        if (closed) {
          return;
        }
        closed = true;
        events.unsubscribe();
        client.open -= 1;
      },
    };
  }

  stop(): void {
    for (const key of [...this.clients.keys()]) {
      this.dispose(key);
    }
  }

  private inUse(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.open > 0) {
        count += 1;
      }
    }
    return count;
  }

  private clientFor(key: string): Client {
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }
    if (this.clients.size >= this.options.maxRelays) {
      for (const [idle, client] of this.clients) {
        if (client.open === 0) {
          this.dispose(idle);
        }
      }
    }
    const rxNostr = this.options.createClient(key);
    const streams = rxNostr.createConnectionStateObservable().subscribe(({ state }) => {
      if (state === 'error' || state === 'rejected') {
        this.giveUp(key, state === 'rejected');
      }
    });
    streams.add(
      rxNostr.createAllMessageObservable().subscribe((packet) => {
        const upstreamSubId = packet.type === 'EOSE' ? fromWireSubId(packet.subId) : undefined;
        if (upstreamSubId) {
          this.options.onEose(upstreamSubId, key);
        }
      })
    );
    const client: Client = { rxNostr, streams, open: 0 };
    this.clients.set(key, client);
    return client;
  }

  /**
   * 開いている購読があれば接続を残し、後で `reconnect()` する。rx-nostr は繋ぎ直すと開いている
   * REQ を送り直すので、開いたままのタイムラインにもその宛先が戻る。
   */
  private giveUp(key: string, rejected: boolean): void {
    const offline = !rejected && this.options.isOffline();
    if (!offline) {
      this.cooldownUntil.set(key, Date.now() + this.options.cooldown);
    }
    const client = this.clients.get(key);
    if (rejected || !client?.open) {
      this.dispose(key);
    } else {
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.set(
        key,
        setTimeout(
          () => this.retry(key),
          offline ? this.options.offlineRetryDelay : this.options.cooldown
        )
      );
    }
    this.options.onGaveUp(key);
  }

  private retry(key: string): void {
    this.retryTimers.delete(key);
    const client = this.clients.get(key);
    if (client?.open) {
      client.rxNostr.reconnect(key);
    } else {
      this.dispose(key);
    }
  }

  /** 捨てる前に通知を外す。外さないと dispose が流す状態変化まで受け取る。 */
  private dispose(key: string): void {
    clearTimeout(this.retryTimers.get(key));
    this.retryTimers.delete(key);
    const client = this.clients.get(key);
    if (!client) {
      return;
    }
    this.clients.delete(key);
    client.streams.unsubscribe();
    client.rxNostr.dispose();
  }
}
