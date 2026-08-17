/**
 * id 指定フィルタのキャッシュ充足判定（id カバレッジ短絡）
 *
 * 鮮度ウィンドウ（`freshness.ts`）は「上流にもっと新しい版があるかもしれない」を
 * 時間で妥協している。`ids` にはその妥協が要らない: id はイベント内容のハッシュで
 * あり、同じ id を持つ「より新しい版」は存在しえないためである。
 *
 * この違いは判定の強さに直結する。`filter.ids` に挙がった id をすべてキャッシュが
 * 持っているなら、そのフィルタにマッチしうるイベントは高々その n 件で、すべて配信
 * 済みなのだから、**上流購読を開いても今後届くものが無い**。EOSE を早めるだけでなく
 * 上流購読そのものが不要になり、失効という概念も無いので設定にも依存しない。
 *
 * 判定材料は「その REQ がローカルから配信した id」だけで、追加のストレージ
 * アクセスは伴わない（`MessageHandler.handleReqMessage` が重複排除のために
 * どのみち集めている）。
 */

import type { Filter } from '@nostr-cache/shared';

/**
 * Whether local storage alone has already answered this filter in full.
 *
 * Judged from what was *delivered* rather than from what storage holds. The two
 * differ when a held event fails another condition of the same filter (a `kinds`
 * that does not match it, an `until` it is newer than) or when `limit` /
 * `maxEventsPerRequest` truncated it away. Proving those cases covered would
 * cost a storage round trip to learn which ids exist, so they are reported
 * uncovered instead and the filter is forwarded upstream exactly as before —
 * the same fail-open direction `narrowFiltersByFreshness` takes.
 *
 * An empty `ids` array counts as covered: it matches nothing locally
 * (`eventMatchesFilter` rejects every event against it), and forwarding it would
 * expose us to an upstream relay that reads `[]` as "no constraint" and answers
 * with its whole store.
 *
 * @param delivered Ids delivered by the REQ this filter belongs to — every
 *   filter of it, not just this one. The question is whether the cache *holds*
 *   the id, and a delivery under any filter of the same REQ proves that.
 */
export function isIdCovered(filter: Filter, delivered: ReadonlySet<string>): boolean {
  if (filter.ids === undefined) {
    return false;
  }
  return filter.ids.every((id) => delivered.has(id));
}

/**
 * Decide which of a REQ's filters still need to be forwarded upstream.
 *
 * Unlike the freshness window this is unconditional — it needs no configuration,
 * because it rests on id being the event's content hash rather than on a policy
 * about how stale a cached copy may be.
 *
 * @param sentIds Ids this REQ delivered from local storage
 * @returns The filters to forward upstream; empty means the subscription is
 *   already complete and can be finished with an immediate EOSE
 */
export function narrowFiltersByIdCoverage(filters: Filter[], sentIds: Iterable<string>): Filter[] {
  if (!filters.some((filter) => filter.ids !== undefined)) {
    return filters;
  }
  const delivered = new Set(sentIds);
  return filters.filter((filter) => !isIdCovered(filter, delivered));
}
