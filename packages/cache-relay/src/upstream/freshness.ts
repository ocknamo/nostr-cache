/**
 * 鮮度ウィンドウ（cache-first freshness window）の判定ロジック
 *
 * 透過キャッシュは既定では REQ をキャッシュのヒット状況に関係なく必ず上流へ
 * 転送する。kind 0（プロフィール）のような replaceable イベントは (pubkey, kind)
 * ごとに最新1件しか存在せず内容もほとんど変化しないため、これは上流トラフィックと
 * EOSE レイテンシの両面で無駄になる。
 *
 * 鮮度ウィンドウは HTTP キャッシュの `max-age` に相当する: 「キャッシュ投入から
 * N 秒以内の replaceable イベントは十分新鮮とみなし、上流に問い合わせない」。
 * 窓が切れていれば従来どおり上流へ転送して再検証する。
 *
 * 判定は純粋関数として切り出し（`storage/priority.ts` と同じパターン）、
 * ストレージアクセスを伴う薄いラッパを {@link FreshnessGate} として提供する。
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
 * Coordinate key of a replaceable event: `<kind>:<pubkey>`.
 *
 * Replaceable kinds keep exactly one event per (pubkey, kind), so this pair
 * fully identifies "the newest version" — no `d` tag is involved (that is what
 * makes addressable kinds, 30000–39999, out of scope here).
 */
function coordinateKey(kind: number, pubkey: string): string {
  return `${kind}:${pubkey}`;
}

/**
 * Whether a cached copy counts as fresh, written so that **every** unusable
 * input falls out as stale.
 *
 * A plain `now - cached > window * 1000` comparison does the opposite: any
 * `NaN` on either side makes the comparison `false` and the copy would be taken
 * as fresh — the one direction that silently breaks transparency. `getCachedAt`
 * is an optional public interface third-party adapters implement (they might
 * return a `Date`, an ISO string, or nothing at all), and `FreshnessGate` is
 * publicly exported, so `windows` can arrive without passing through
 * `normalizeFreshnessWindows`. Neither input is trusted here.
 *
 * A `cached` timestamp in the future is also treated as stale: `Date.now()` is
 * not monotonic, and a SQLite-backed cache compares timestamps across process
 * restarts, so clock skew must not hand out an unbounded window.
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
 * Whether a filter is a candidate for the freshness window at all.
 *
 * The window can only skip a filter when the *complete* set of events that
 * filter asks for is enumerable up front — otherwise "the cache already has
 * everything" is unknowable. That requires every condition below; a filter
 * failing any one of them is always forwarded upstream unchanged.
 *
 * - `kinds` non-empty and every kind replaceable **and** configured with a
 *   window. A single regular kind (e.g. kind 1) makes the result set unbounded.
 * - `authors` non-empty — the coordinates are `kinds × authors`, so without
 *   authors there is nothing to enumerate.
 * - No `ids`: an id-keyed lookup is a different (and stronger) short-circuit —
 *   see `id-coverage.ts`, which needs no window at all.
 * - No `since` / `until`: `until` asks for the newest version *as of* that
 *   moment, which is not necessarily the newest version the cache holds.
 * - No tag conditions: a `#`-prefixed condition narrows the result set in a way
 *   the coordinate enumeration does not model.
 *
 * `limit` is allowed: a truncated response simply leaves coordinates uncovered,
 * which makes {@link narrowFiltersByFreshness} forward the filter anyway.
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
 * Decide which of a REQ's filters still need to be forwarded upstream.
 *
 * A filter is dropped only when *every* coordinate it asks for was served from
 * cache by this REQ and is still inside its window. Anything else — one stale
 * copy, one missing author, one unknown `cached_at` — forwards the filter
 * unchanged (all-or-nothing; no narrowed residual filter is synthesized).
 *
 * @param sentEvents Events this REQ actually delivered to the client. Must be
 *   the post-`limit`, post-`maxEventsPerRequest` list: an event that was
 *   truncated away was never delivered, so it must not count as coverage.
 * @returns The filters to forward upstream; empty means upstream can be skipped
 *   entirely for this subscription
 */
export function narrowFiltersByFreshness(
  filters: Filter[],
  sentEvents: NostrEvent[],
  cachedAt: ReadonlyMap<string, number>,
  windows: FreshnessWindows,
  nowMs: number
): Filter[] {
  // 窓の内側にあるイベントの座標集合。フィルタ横断で1回だけ作る。
  //
  // どのフィルタが取ってきたイベントかは区別しない: 座標は (kind, pubkey) で
  // 一意にその replaceable イベントの最新版を指し、それがこの購読でクライアントへ
  // 届いている事実はフィルタの別によらないため。
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
 * Storage-backed wrapper around {@link narrowFiltersByFreshness}.
 *
 * Present on the relay only when `upstreamFreshness` is configured. Every
 * failure mode fails open (returns the filters unchanged, so the REQ is
 * forwarded upstream exactly as before): serving a filter from a cache we
 * cannot prove fresh is the one outcome that silently breaks transparency.
 */
export class FreshnessGate {
  /** Ensures the "storage does not support getCachedAt" warning logs once. */
  private unsupportedWarned = false;

  /**
   * @param storage Storage adapter (must implement `getCachedAt` for the
   *   window to have any effect)
   */
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

    // 窓が設定された kind のイベントだけ問い合わせる（他は判定に使わない）
    const ids = sentEvents.filter((event) => this.windows.has(event.kind)).map((event) => event.id);
    if (ids.length === 0) {
      // 充足しうる座標が1つもない → 必ず全フィルタが上流へ行く
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
   * Record that an upstream relay just confirmed a copy this cache already
   * holds, re-arming its window.
   *
   * Without this the window would only ever fire once per event. When the window
   * expires the REQ is forwarded upstream, but for a replaceable event whose
   * content has not changed the upstream answer is the *same event id* — which
   * the coordinator dedupes away before `ingest`, so `cached_at` is never
   * rewritten. The window would then stay expired forever and every later REQ
   * would go upstream again, which is exactly the traffic this option exists to
   * avoid (unchanged profiles are the common case).
   *
   * Fire-and-forget: this is cache bookkeeping on the read path, so a failure
   * must never affect the REQ. Only kinds that actually have a window are
   * touched, so a high-volume regular kind never reaches storage here.
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
