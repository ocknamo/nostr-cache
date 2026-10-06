/**
 * 著者の kind 10002 をキャッシュへ揃える。宛先の決定（ルーティング）はこの層の外。
 * 方針は doc/TODO.md「アウトボックスモデル / NIP-65」を参照。
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { logger } from '@nostr-cache/shared';
import { RELAY_LIST_KIND } from '../event/event-kind.js';
import { selectCurrentVersion } from '../event/replaceable.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { IndexFetchResult } from './index-relay-client.js';
import { type RelayList, parseRelayList } from './relay-list.js';

/** インデックスリレーが 1 REQ を 500 件で黙って打ち切るため、それを下回らせる。 */
export const DEFAULT_RELAY_LIST_BATCH_SIZE = 300;

/** ms。どのインデックスリレーも答えなかったとき、同じ人を聞き直すまでの間。 */
const RETRY_AFTER_SILENCE = 60_000;

/** 1 つのフォローリストからも、取得待ち全体でも、これ以上は先読みしない。 */
export const MAX_PREFETCH_AUTHORS = 2000;

const HEX64 = /^[0-9a-f]{64}$/;

export interface RelayListResolverDeps {
  storage: StorageAdapter;
  fetch: (filter: Filter) => Promise<IndexFetchResult>;
  /** 通常の取り込み経路（検証・版比較・保存）。 */
  ingest: (event: NostrEvent) => Promise<unknown>;
}

export interface RelayListResolverOptions {
  /** キャッシュ済みの 10002 を取り直さずに使う秒数。 */
  freshnessSeconds: number;
  batchSize?: number;
  now?: () => number;
}

export class RelayListResolver {
  private readonly batchSize: number;
  private readonly now: () => number;
  /**
   * 問い合わせ済みの時刻 (ms)。10002 を持たない人はストレージに痕跡が残らないので、
   * これが無いと窓の内側でも毎回インデックスリレーへ聞きに行く。
   */
  private readonly checkedAt = new Map<string, number>();
  /** 落ちている間に REQ のたびに問い合わせを待たせないよう、無応答だった人を覚えておく。 */
  private readonly retryAfter = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** インデックスリレーへ並べて投げないよう、バッチを 1 本ずつ流す。 */
  private queue: Promise<void> = Promise.resolve();
  /** 同じフォローリストを開きっぱなしでも、窓が切れたら先読みし直す。 */
  private readonly prefetchedAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly deps: RelayListResolverDeps,
    private readonly options: RelayListResolverOptions
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_RELAY_LIST_BATCH_SIZE);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
  }

  /** キャッシュを消したら、「取得済み」の記憶も捨てる。残すと窓のあいだ取り直さない。 */
  forget(): void {
    this.checkedAt.clear();
    this.retryAfter.clear();
    this.prefetchedAt.clear();
  }

  stop(): void {
    this.stopped = true;
  }

  /** キャッシュに無いか窓が切れた人の 10002 を取り込み、終わったら解決する。 */
  async resolve(pubkeys: string[]): Promise<void> {
    const waiting = new Set<Promise<void>>();
    const candidates: string[] = [];
    for (const pubkey of new Set(pubkeys.map((p) => p.toLowerCase()))) {
      if (!HEX64.test(pubkey)) {
        continue;
      }
      const pending = this.inflight.get(pubkey);
      if (pending) {
        waiting.add(pending);
      } else if (!this.checkedRecently(pubkey)) {
        candidates.push(pubkey);
      }
    }

    // ストレージを見ている間に別の resolve が同じ人を投げていれば、そちらを待つ
    const stale = (await this.staleAmong(candidates)).filter((pubkey) => {
      const pending = this.inflight.get(pubkey);
      if (pending) {
        waiting.add(pending);
        return false;
      }
      return true;
    });

    for (let i = 0; i < stale.length; i += this.batchSize) {
      const batch = stale.slice(i, i + this.batchSize);
      const done = this.enqueue(batch);
      for (const pubkey of batch) {
        this.inflight.set(pubkey, done);
      }
      waiting.add(done);
    }
    await Promise.all(waiting);
  }

  /**
   * フォローリストが届いたら、その全員の 10002 を背後で揃えておく。後段で宛先を
   * 決めるときに、初回表示へインデックスリレーとの往復を足さないため。
   */
  prefetchFollows(followList: NostrEvent): void {
    if (this.stopped || followList.kind !== 3 || !Array.isArray(followList.tags)) {
      return;
    }
    const prefetched = this.prefetchedAt.get(followList.id);
    if (prefetched !== undefined && this.withinWindow(prefetched)) {
      return;
    }
    // 他人のフォローリストをまとめて引く REQ でも、取得待ちを際限なく積まない
    if (this.inflight.size >= MAX_PREFETCH_AUTHORS) {
      return;
    }
    this.prefetchedAt.set(followList.id, this.now());
    const follows: string[] = [];
    for (const tag of followList.tags) {
      if (follows.length >= MAX_PREFETCH_AUTHORS) {
        break;
      }
      if (Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string') {
        follows.push(tag[1]);
      }
    }
    this.resolve(follows).catch((error) => {
      logger.debug('Relay list prefetch failed:', error);
    });
  }

  /** 検証済みの 10002 だけを返す。未検証の版を宛先の根拠にしないため。 */
  async lookup(pubkeys: string[]): Promise<Map<string, RelayList>> {
    const result = new Map<string, RelayList>();
    const authors = [...new Set(pubkeys.map((p) => p.toLowerCase()))].filter((p) => HEX64.test(p));
    if (authors.length === 0) {
      return result;
    }
    const current = await this.currentLists(authors);
    const statuses = await this.deps.storage.getValidationStatus(
      [...current.values()].map((event) => event.id)
    );
    for (const [pubkey, event] of current) {
      if (statuses.get(event.id) === 'validated') {
        result.set(pubkey, parseRelayList(event));
      }
    }
    return result;
  }

  private checkedRecently(pubkey: string): boolean {
    const checked = this.checkedAt.get(pubkey);
    if (checked !== undefined && this.withinWindow(checked)) {
      return true;
    }
    return (this.retryAfter.get(pubkey) ?? 0) > this.now();
  }

  private withinWindow(at: number): boolean {
    return this.now() - at <= this.options.freshnessSeconds * 1000;
  }

  /** `getCachedAt` が無いアダプタでは全員を古い扱いにする（鮮度ウィンドウと同じ倒し方）。 */
  private async staleAmong(pubkeys: string[]): Promise<string[]> {
    if (pubkeys.length === 0) {
      return [];
    }
    const getCachedAt = this.deps.storage.getCachedAt?.bind(this.deps.storage);
    if (!getCachedAt) {
      return pubkeys;
    }
    try {
      const current = await this.currentLists(pubkeys);
      const cachedAt = await getCachedAt([...current.values()].map((event) => event.id));
      const now = this.now();
      const windowMs = this.options.freshnessSeconds * 1000;
      return pubkeys.filter((pubkey) => {
        const event = current.get(pubkey);
        const cached = event ? cachedAt.get(event.id) : undefined;
        if (cached === undefined || cached > now || now - cached > windowMs) {
          return true;
        }
        // 投入時刻で記録する（今で記録すると窓が倍に延びる）。次からストレージを引かない
        this.checkedAt.set(pubkey, cached);
        return false;
      });
    } catch (error) {
      logger.debug('Relay list freshness check failed:', error);
      return pubkeys;
    }
  }

  private async currentLists(pubkeys: string[]): Promise<Map<string, NostrEvent>> {
    const events = await this.deps.storage.getEvents([
      { kinds: [RELAY_LIST_KIND], authors: pubkeys },
    ]);
    return newestByPubkey(events);
  }

  private enqueue(batch: string[]): Promise<void> {
    const run = this.queue.then(() => this.fetchBatch(batch));
    this.queue = run;
    return run;
  }

  /**
   * reject しない。止められたときは問い合わせ済みにせず次の resolve で取り直し、どのリレーも
   * 答えなかったときは少し間を置いてから取り直す。
   */
  private async fetchBatch(batch: string[]): Promise<void> {
    try {
      if (this.stopped) {
        return;
      }
      const asked = new Set(batch);
      const { events, answered } = await this.deps.fetch({
        kinds: [RELAY_LIST_KIND],
        authors: batch,
      });
      if (this.stopped) {
        return;
      }
      if (answered === 0) {
        const retry = this.now() + RETRY_AFTER_SILENCE;
        for (const pubkey of batch) {
          this.retryAfter.set(pubkey, retry);
        }
        return;
      }
      // 旧版まで返すインデックスリレーがあるので、取り込む前に 1 人 1 件へ畳む。
      // 取り込みは直列にする（同じ座標の置換が競合すると古い版が残りうる）
      const newest = newestByPubkey(
        events.filter((event) => event.kind === RELAY_LIST_KIND && asked.has(event.pubkey))
      );
      for (const event of newest.values()) {
        if (this.stopped) {
          return;
        }
        try {
          await this.deps.ingest(event);
        } catch (error) {
          logger.debug('Relay list ingest failed:', error);
        }
      }
      const checked = this.now();
      for (const pubkey of batch) {
        this.checkedAt.set(pubkey, checked);
      }
    } catch (error) {
      logger.debug('Relay list fetch failed:', error);
    } finally {
      for (const pubkey of batch) {
        this.inflight.delete(pubkey);
      }
    }
  }
}

function newestByPubkey(events: NostrEvent[]): Map<string, NostrEvent> {
  const byPubkey = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const versions = byPubkey.get(event.pubkey) ?? [];
    versions.push(event);
    byPubkey.set(event.pubkey, versions);
  }
  const newest = new Map<string, NostrEvent>();
  for (const [pubkey, versions] of byPubkey) {
    const current = selectCurrentVersion(versions);
    if (current) {
      newest.set(pubkey, current);
    }
  }
  return newest;
}
