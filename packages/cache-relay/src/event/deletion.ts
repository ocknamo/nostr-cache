/**
 * NIP-09（削除リクエスト）の解釈。適用ルールは doc/api.md を参照。
 *
 * `a` タグは著者を含むのでここで絞れるが、`e` タグは含まないため、同一 pubkey か
 * どうかの判定は保存行を見られるストレージアダプタに委譲している。
 */

import { logger } from '@nostr-cache/shared';
import type { NostrEvent } from '@nostr-cache/shared';
import type { EventAddress, StorageAdapter } from '../storage/storage-adapter.js';
import { isAddressableKind, isCoordinateAddressableKind, isDeletionKind } from './event-kind.js';

/** 64-char lowercase hex, as pubkeys appear in `a` tag coordinates. */
const HEX_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

/** Event ids referenced by `e` tags (32-byte lowercase hex). */
const HEX_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Canonical decimal kind: digits only, no leading zeros (except `0` itself). */
const KIND_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * タグ種別ごとの上限。座標 1 件につきストレージ往復が 1 回で、server では SQLite に
 * 同期実行されるため、無制限だと 1 通の EVENT でリレーを好きなだけ塞げる。超過分は
 * リクエストを拒否せず捨てる（リクエスト自体は保存・転送する価値がある）。
 */
export const MAX_DELETION_REFERENCES = 1000;

/** 不正・対象外の参照を落としたあとの削除対象。 */
export interface DeletionRequest {
  /** このリクエストの著者。削除できるのはこの著者のイベントだけ。 */
  pubkey: string;
  /** `e` タグ（重複排除済み） */
  ids: string[];
  /** `a` タグ（重複排除済み・すべて `pubkey` の著作） */
  addresses: EventAddress[];
  /** 座標削除はこの時刻以前の版にだけ適用する。後から公開された版は残る。 */
  until: number;
}

export function isDeletionEvent(event: Pick<NostrEvent, 'kind'>): boolean {
  return isDeletionKind(event.kind);
}

/** 識別子自体が `:` を含みうるので、区切りとして意味を持つのは先頭 2 つだけ。 */
export function parseAddress(value: string): EventAddress | undefined {
  const firstColon = value.indexOf(':');
  if (firstColon <= 0) {
    return undefined;
  }
  const secondColon = value.indexOf(':', firstColon + 1);
  if (secondColon < 0) {
    return undefined;
  }

  const rawKind = value.slice(0, firstColon);
  const pubkey = value.slice(firstColon + 1, secondColon);
  const identifier = value.slice(secondColon + 1);

  // Number の寛容さで '1.5' / '0x1' / ' 1' を取り込まないよう桁だけを許し、
  // 先行ゼロ（'007'）も非正規形として弾く
  if (!KIND_PATTERN.test(rawKind)) {
    return undefined;
  }
  const kind = Number(rawKind);
  if (!Number.isSafeInteger(kind) || !HEX_PUBKEY_PATTERN.test(pubkey)) {
    return undefined;
  }

  return { kind, pubkey, identifier };
}

/**
 * パース時に落とすもの: 32 バイト hex でない `e` タグ、壊れている・他人を指す・座標で
 * 参照できない kind を指す `a` タグ、{@link MAX_DELETION_REFERENCES} を超える分。
 * kind 5 への自己参照は、対象の kind が見えるストレージアダプタ側で弾く。
 *
 * `NONE` 検証モードでは壊れた `tags` も到達しうるので許容する。
 */
export function parseDeletionRequest(event: NostrEvent): DeletionRequest {
  const ids = new Set<string>();
  const addresses = new Map<string, EventAddress>();
  let dropped = 0;

  for (const tag of Array.isArray(event.tags) ? event.tags : []) {
    if (!Array.isArray(tag)) {
      continue;
    }
    const [name, value] = tag;
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    if (name === 'e') {
      if (!HEX_ID_PATTERN.test(value)) {
        continue;
      }
      if (ids.size >= MAX_DELETION_REFERENCES && !ids.has(value)) {
        dropped++;
        continue;
      }
      ids.add(value);
      continue;
    }

    if (name === 'a') {
      const address = parseAddress(value);
      if (
        address === undefined ||
        address.pubkey !== event.pubkey ||
        !isCoordinateAddressableKind(address.kind)
      ) {
        continue;
      }
      // 同じ座標を指す複数の a タグは 1 回にまとめる
      const key = `${address.kind}:${address.pubkey}:${address.identifier}`;
      if (addresses.size >= MAX_DELETION_REFERENCES && !addresses.has(key)) {
        dropped++;
        continue;
      }
      addresses.set(key, address);
    }
  }

  if (dropped > 0) {
    logger.info(
      `Deletion request ${event.id}: dropped ${dropped} references over the ${MAX_DELETION_REFERENCES} per-type limit`
    );
  }

  return {
    pubkey: event.pubkey,
    ids: Array.from(ids),
    addresses: Array.from(addresses.values()),
    until: event.created_at,
  };
}

/**
 * ストレージアダプタ共通のガード。{@link parseDeletionRequest} が既に弾く内容だが、
 * `deleteEventsByAddress` は直接呼べる公開メソッドなので繰り返す。
 *
 * `until` に有限数を要求するのは、IndexedDB が文字列を全数値より上に並べるため。
 * 非数値の上限は範囲を黙って「全版」に変えてしまう。
 */
export function isDeletableAddress(address: EventAddress, until: number): boolean {
  return isCoordinateAddressableKind(address.kind) && Number.isFinite(until);
}

/**
 * 両アダプタが座標を同じに解釈するための純粋関数。`d` タグを持つのは addressable だけで、
 * replaceable では識別子はアドレスの一部ではない。`d` 無しは空識別子（NIP-01）。
 */
export function matchesAddressIdentifier(tags: string[][], address: EventAddress): boolean {
  if (!isAddressableKind(address.kind)) {
    return true;
  }
  const dTag = tags.find((tag) => tag[0] === 'd');
  return (dTag?.[1] ?? '') === address.identifier;
}

/**
 * 冪等。同じリクエストを受け直しても新たに削除されるものが無いだけ。
 *
 * パース・ストレージの失敗はログのみで握り潰す。リクエスト自体は保存済みで次回
 * 到着時に再適用され、呼び出し側は throw しないことに依存している
 * （`publishEvent` はこの時点で保存を確定させている）。
 */
export async function applyDeletionRequest(
  storage: StorageAdapter,
  event: NostrEvent
): Promise<number> {
  let deleted = 0;

  try {
    const request = parseDeletionRequest(event);
    if (request.ids.length > 0) {
      deleted += await storage.deleteEventsByIdsForPubkey(request.ids, request.pubkey);
    }
    for (const address of request.addresses) {
      deleted += await storage.deleteEventsByAddress(address, request.until);
    }
  } catch (error) {
    logger.error('Failed to apply deletion request:', error);
  }

  if (deleted > 0) {
    logger.info(`Deleted ${deleted} events for deletion request ${event.id}`);
  }

  return deleted;
}
