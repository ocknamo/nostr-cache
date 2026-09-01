/**
 * 鮮度ウィンドウ（cache-first freshness window）の判定。
 * 目的・トレードオフは doc/cache-relay/upstream.md 第5節を参照。
 *
 * 判定は純粋関数、ストレージアクセスを伴う薄いラッパが {@link FreshnessGate}。
 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { logger } from '@nostr-cache/shared';
import { isReplaceableKind } from '../event/event-kind.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';

/**
 * 鮮度ウィンドウの設定。kind → 「その kind のキャッシュを新鮮とみなす秒数」。
 *
 * 収録されるのは replaceable な kind のみ（`normalizeFreshnessWindows` が
 * 構築時に検証する）。
 */
export type FreshnessWindows = ReadonlyMap<number, number>;

/**
 * replaceable は (pubkey, kind) ごとに 1 件なので、この組だけで最新版を一意に指せる。
 * `d` タグを持つ addressable がこの層の対象外なのはこれが理由。
 */
function coordinateKey(kind: number, pubkey: string): string {
  return `${kind}:${pubkey}`;
}

/**
 * 使えない入力が**すべて**「古い」側に落ちるように書いてある。素直に
 * `now - cached > window * 1000` と書くと `NaN` が「新鮮」に倒れ、透過性が静かに壊れる。
 * `getCachedAt` も `FreshnessGate` も公開されていて、第三者の実装から任意の値が来る。
 */
function isWithinWindow(
  cached: number | undefined,
  windowSeconds: number | undefined,
  nowMs: number
): boolean {
  if (windowSeconds === undefined || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return false;
  }
  if (cached === undefined || !Number.isFinite(cached) || !Number.isFinite(nowMs)) {
    return false;
  }
  // 未来の cached_at はクロックスキュー。窓を無限に伸ばさないよう古い扱いにする
  if (cached > nowMs) {
    return false;
  }
  return nowMs - cached <= windowSeconds * 1000;
}

/**
 * 窓で飛ばせるのは、そのフィルタが要求するイベント集合を事前に列挙できる場合だけ。
 * 列挙できなければ「キャッシュが全部持っている」を判定しようがない。条件のどれかを
 * 満たさないフィルタは常にそのまま上流へ転送する。
 *
 * `limit` は許す。切り詰められた分は未充足の座標として残り、結局転送されるため。
 */
export function isFreshnessEligible(filter: Filter, windows: FreshnessWindows): boolean {
  if (filter.ids !== undefined) return false;
  if (filter.since !== undefined || filter.until !== undefined) return false;
  if (!filter.kinds?.length || !filter.authors?.length) return false;

  for (const kind of filter.kinds) {
    if (!isReplaceableKind(kind) || !windows.has(kind)) return false;
  }

  // タグ条件つきは座標列挙の対象外（`#d` を含む。addressable は今回対象外）
  for (const key of Object.keys(filter)) {
    if (key.startsWith('#')) return false;
  }

  return true;
}

/**
 * 上流へ転送する必要が残っているフィルタを返す。要求する座標が 1 つでも古い・欠けて
 * いれば、そのフィルタは元のまま転送する（all-or-nothing。残余フィルタは作らない）。
 *
 * @param sentEvents `limit` / `maxEventsPerRequest` で切り詰めた**後**の配信済みリスト。
 *   切り詰められたイベントは配信されていないので充足に数えてはいけない
 */
export function narrowFiltersByFreshness(
  filters: Filter[],
  sentEvents: NostrEvent[],
  cachedAt: ReadonlyMap<string, number>,
  windows: FreshnessWindows,
  nowMs: number
): Filter[] {
  // 座標は (kind, pubkey) で最新版を一意に指すので、どのフィルタ由来かは区別しない。
  const fresh = new Set<string>();
  for (const event of sentEvents) {
    const windowSeconds = windows.get(event.kind);
    const cached = cachedAt.get(event.id);
    if (!isWithinWindow(cached, windowSeconds, nowMs)) continue;
    fresh.add(coordinateKey(event.kind, event.pubkey));
  }

  return filters.filter((filter) => {
    if (!isFreshnessEligible(filter, windows)) return true;
    // isFreshnessEligible が kinds / authors の非空を保証している
    const kinds = filter.kinds as number[];
    const authors = filter.authors as string[];
    for (const kind of kinds) {
      for (const pubkey of authors) {
        if (!fresh.has(coordinateKey(kind, pubkey))) return true;
      }
    }
    return false;
  });
}

/**
 * {@link narrowFiltersByFreshness} にストレージアクセスを足したもの。
 * 失敗はすべてフェイルオープン（フィルタをそのまま返す）。新鮮だと証明できない
 * キャッシュで応答するのが、透過性を静かに壊す唯一の方向だから。
 */
export class FreshnessGate {
  /** 未対応ストレージの警告は 1 回だけ出す。 */
  private unsupportedWarned = false;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly windows: FreshnessWindows,
    private readonly now: () => number = () => Date.now()
  ) {}

  async filtersForUpstream(filters: Filter[], sentEvents: NostrEvent[]): Promise<Filter[]> {
    if (!filters.some((filter) => isFreshnessEligible(filter, this.windows))) {
      return filters;
    }

    if (typeof this.storage.getCachedAt !== 'function') {
      if (!this.unsupportedWarned) {
        logger.warn(
          'upstreamFreshness is configured but the storage adapter does not support getCachedAt'
        );
        this.unsupportedWarned = true;
      }
      return filters;
    }

    const ids = sentEvents.filter((event) => this.windows.has(event.kind)).map((event) => event.id);
    if (ids.length === 0) {
      return filters;
    }

    let cachedAt: ReadonlyMap<string, number>;
    try {
      cachedAt = await this.storage.getCachedAt(ids);
    } catch (error) {
      logger.error('Failed to read cache insertion times; forwarding upstream:', error);
      return filters;
    }

    return narrowFiltersByFreshness(filters, sentEvents, cachedAt, this.windows, this.now());
  }

  /**
   * 上流が「キャッシュ済みの版が最新だ」と確認したときに窓を張り直す。
   *
   * これが無いと窓はイベントごとに 1 回しか効かない。内容の変わらない replaceable では
   * 上流の答えが同じ id になり、coordinator が `ingest` の前に重複排除するので
   * `cached_at` が更新されないため。fire-and-forget で、失敗しても REQ に影響させない。
   */
  markRevalidated(event: NostrEvent): void {
    if (!this.windows.has(event.kind) || typeof this.storage.touchCachedAt !== 'function') {
      return;
    }
    void this.storage.touchCachedAt([event.id]).catch((error) => {
      logger.debug('Failed to re-arm the freshness window:', error);
    });
  }
}
