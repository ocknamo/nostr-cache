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
  /** 自分側の断線で落ちた宛先を、作り直して送り直すまでの間 (ms)。 */
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

interface Subscription {
  upstreamSubId: string;
  filters: Filter[];
  owner?: Client;
  events?: { unsubscribe(): void };
  closed: boolean;
}

interface Client {
  rxNostr: RxNostr;
  streams: { unsubscribe(): void };
  /** このリレーで開いている購読。空のものは枠を数えず、溢れたら捨ててよい。 */
  subscriptions: Set<Subscription>;
}

export class TemporaryRelays {
  private readonly clients = new Map<string, Client>();
  private readonly cooldownUntil = new Map<string, number>();
  /** 落ちたリレーで開いたままだった購読。 */
  private readonly orphans = new Map<string, Set<Subscription>>();
  private readonly reviveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: TemporaryRelaysOptions) {}

  isCoolingDown(relay: string): boolean {
    const key = relayKey(relay);
    const until = this.cooldownUntil.get(key);
    if (until === undefined) {
      return false;
    }
    if (Date.now() < until) {
      return true;
    }
    this.cooldownUntil.delete(key);
    return false;
  }

  /**
   * 書き込みで繋がらなかったリレーも、読み込みと同じく宛先から外す。読み込みで使っている
   * 間は一時的な失敗とみて外さない（本当に落ちれば読み込み側が外す）。
   */
  coolDown(relay: string): void {
    const key = relayKey(relay);
    if (!this.options.isOffline() && !this.clients.get(key)?.subscriptions.size) {
      this.cooldownUntil.set(key, Date.now() + this.options.cooldown);
    }
  }

  canReach(relay: string): boolean {
    const key = relayKey(relay);
    if (this.isCoolingDown(key)) {
      return false;
    }
    return (
      (this.clients.get(key)?.subscriptions.size ?? 0) > 0 || this.inUse() < this.options.maxRelays
    );
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
    const subscription: Subscription = { upstreamSubId, filters, closed: false };
    this.attach(key, this.clientFor(key), subscription);
    return {
      unsubscribe: () => {
        if (subscription.closed) {
          return;
        }
        subscription.closed = true;
        subscription.events?.unsubscribe();
        subscription.owner?.subscriptions.delete(subscription);
        this.orphans.get(key)?.delete(subscription);
      },
    };
  }

  stop(): void {
    for (const timer of this.reviveTimers.values()) {
      clearTimeout(timer);
    }
    this.reviveTimers.clear();
    this.orphans.clear();
    for (const key of [...this.clients.keys()]) {
      this.dispose(key);
    }
  }

  private attach(key: string, client: Client, subscription: Subscription): void {
    subscription.owner = client;
    client.subscriptions.add(subscription);
    const req = createRxForwardReq(subscription.upstreamSubId);
    // Subscribe before emitting: the request stream is hot.
    subscription.events = client.rxNostr.use(req).subscribe(({ event }) => {
      this.options.onEvent(subscription.upstreamSubId, event as NostrEvent, key);
    });
    req.emit(subscription.filters as LazyFilter[]);
  }

  private inUse(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.subscriptions.size > 0) {
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
        if (client.subscriptions.size === 0) {
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
    const client: Client = { rxNostr, streams, subscriptions: new Set() };
    this.clients.set(key, client);
    return client;
  }

  /**
   * 開いていた購読は、冷却が明けたら（自分側の断線なら少し置いて）作り直した接続へ送り直す。
   * そうしないと、開いたままのタイムラインはその宛先を二度と読まない。
   */
  private giveUp(key: string, rejected: boolean): void {
    const offline = !rejected && this.options.isOffline();
    if (!offline) {
      this.cooldownUntil.set(key, Date.now() + this.options.cooldown);
    }
    const live = [...(this.clients.get(key)?.subscriptions ?? [])].filter((sub) => !sub.closed);
    this.dispose(key);
    if (live.length > 0 && !rejected) {
      // 送り直しを待っている分に足す。置き換えると、待っている間に開いた購読で上書きされる
      const orphans = this.orphans.get(key) ?? new Set();
      for (const subscription of live) {
        orphans.add(subscription);
      }
      this.orphans.set(key, orphans);
      this.scheduleRevive(key, offline ? this.options.offlineRetryDelay : this.options.cooldown);
    }
    this.options.onGaveUp(key);
  }

  private scheduleRevive(key: string, delay: number): void {
    clearTimeout(this.reviveTimers.get(key));
    this.reviveTimers.set(
      key,
      setTimeout(() => this.revive(key), delay)
    );
  }

  /** まだ冷却中（タイマーが早く来た）か枠が埋まっていれば、捨てずに待ち直す。 */
  private revive(key: string): void {
    this.reviveTimers.delete(key);
    const orphans = [...(this.orphans.get(key) ?? [])].filter((sub) => !sub.closed);
    if (orphans.length === 0) {
      this.orphans.delete(key);
      return;
    }
    if (!this.canReach(key)) {
      const until = this.cooldownUntil.get(key);
      this.scheduleRevive(key, until === undefined ? this.options.cooldown : until - Date.now());
      return;
    }
    this.orphans.delete(key);
    const client = this.clientFor(key);
    for (const subscription of orphans) {
      this.attach(key, client, subscription);
    }
  }

  /** 捨てる前に通知を外す。外さないと dispose が流す状態変化まで受け取る。 */
  private dispose(key: string): void {
    const client = this.clients.get(key);
    if (!client) {
      return;
    }
    this.clients.delete(key);
    client.streams.unsubscribe();
    for (const subscription of client.subscriptions) {
      subscription.events = undefined;
      subscription.owner = undefined;
    }
    client.rxNostr.dispose();
  }
}
