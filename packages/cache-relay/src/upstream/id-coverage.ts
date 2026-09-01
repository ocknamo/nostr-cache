/**
 * id 指定フィルタのキャッシュ充足判定（id カバレッジ短絡）。
 * 判定条件は doc/cache-relay/upstream.md 第6節を参照。
 *
 * id は内容のハッシュなので「より新しい版」が存在しえず、鮮度ウィンドウと違って
 * 失効しない。全 id が配信済みなら上流購読そのものが不要になる。
 */

import type { Filter } from '@nostr-cache/shared';

/**
 * Whether local storage alone has already answered this filter in full.
 *
 * 判定材料は「保持している id」ではなく「配信した id」。保持していても同じフィルタの
 * 他の条件や `limit` で落ちた分は追加のストレージ往復なしには確かめられないので、
 * 未充足として上流へ転送する（フェイルオープン）。
 *
 * 空の `ids` は充足扱い。ローカルでは何にもマッチしない一方、転送すると `[]` を
 * 「制約なし」と読む上流に全件返されうるため。
 *
 * @param delivered この REQ が配信した id。フィルタ単位ではなく REQ 単位で見る
 */
export function isIdCovered(filter: Filter, delivered: ReadonlySet<string>): boolean {
  // `isValidFilterShape` は選言なので、`{"ids":"abc","limit":1}` は `limit` だけで
  // 通る。ここが非配列で最初に throw する場所で、throw すると REQ が EOSE も CLOSED も
  // 受け取れずに終わる。
  if (!Array.isArray(filter.ids)) {
    return false;
  }
  return filter.ids.every((id) => delivered.has(id));
}

/**
 * 上流へ転送する必要が残っているフィルタを返す。空なら即 EOSE で購読を閉じてよい。
 */
export function narrowFiltersByIdCoverage(filters: Filter[], sentIds: Iterable<string>): Filter[] {
  if (!filters.some((filter) => Array.isArray(filter.ids))) {
    return filters;
  }
  const delivered = new Set(sentIds);
  return filters.filter((filter) => !isIdCovered(filter, delivered));
}
