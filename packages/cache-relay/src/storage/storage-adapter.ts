import type { Filter, NostrEvent } from '@nostr-cache/shared';
import type { CachePriority } from './priority.js';

/**
 * 各メソッドの契約（引数・戻り値・実装が守るべき規則）は doc/api.md の
 * `interface StorageAdapter` を参照。ここには実装時に外せない要点だけを書く。
 */

/**
 * - `FIFO`: `created_at` が古い順
 * - `LRU`: 読み出しが古い順（`getEvents` で追跡。挿入も 1 回のアクセス）
 * - `LFU`: 読み出し頻度が低い順、同数なら読み出しが古い順
 */
export type CacheStrategy = 'LRU' | 'FIFO' | 'LFU';

/** `unknown` = そのイベントが保存されていない（未保存・削除済み・退避済み）。 */
export type ValidationStatus = 'validated' | 'pending' | 'unknown';

/** NIP-01 の `a` タグが指す座標（`<kind>:<pubkey>:<d-identifier>`）。 */
export interface EventAddress {
  kind: number;
  pubkey: string;
  /** `d` タグ値。置換可能 kind では空文字列。 */
  identifier: string;
}

export interface SaveEventOptions {
  /** 検証済みとして保存する。既定は false（未検証）。 */
  validated?: boolean;
}

export interface StorageAdapter {
  saveEvent(event: NostrEvent, options?: SaveEventOptions): Promise<boolean>;

  /**
   * 未検証イベントを保存時刻の古い順に返す（遅延検証の永続キュー）。
   * アクセス追跡はしない。
   */
  getUnvalidatedEvents(limit: number): Promise<NostrEvent[]>;

  /** 保存されていない id は無視する。 */
  markValidated(ids: string[]): Promise<void>;

  /** クライアントが高頻度でポーリングしうるため、アクセス追跡はしない。 */
  getValidationStatus(ids: string[]): Promise<Map<string, ValidationStatus>>;

  getEvents(filters: Filter[]): Promise<NostrEvent[]>;

  /**
   * 座標に保存されている版（NIP-01 が残すべき 1 件）を返す。書き込み経路の事前確認
   * なのでアクセス追跡はしない。
   *
   * **他のメソッドと違い失敗を握り潰してはいけない。** 「未保存」と「読み出し失敗」を
   * 呼び出し側が区別できず、後者を前者として返すと古い版で新しい版を上書きする。
   */
  getCurrentVersion(address: EventAddress): Promise<NostrEvent | undefined>;

  /**
   * キャッシュ投入時刻（ミリ秒）。イベント自身の `created_at` ではなく、TTL が期限判定に
   * 使う時刻。未保存の id はマップに含めない（呼び出し側は「新鮮でない」と扱う）。
   *
   * `upstreamFreshness` 用の optional。省略したアダプタでは窓が無効になる。
   */
  getCachedAt?(ids: string[]): Promise<Map<string, number>>;

  /**
   * `cached_at` を現在時刻へ打ち直し、更新件数を返す（エラー時 0）。上流が「キャッシュ済みの
   * 版が最新だ」と確認したときに鮮度ウィンドウを張り直すためのもので、これが無いと内容の
   * 変わらない replaceable では窓が二度と再武装しない（上流エコーは重複排除で
   * `saveEvent` に届かないため）。再保存と同じく TTL も数え直しになる。
   *
   * 検証状態とアクセスメタデータは変更しない。
   */
  touchCachedAt?(ids: string[]): Promise<number>;

  deleteEvent(id: string): Promise<boolean>;

  clear(): Promise<void>;

  count(): Promise<number>;

  deleteEventsByPubkeyAndKind(pubkey: string, kind: number): Promise<boolean>;

  deleteEventsByPubkeyKindAndDTag(
    pubkey: string,
    kind: number,
    dTagValue: string
  ): Promise<boolean>;

  /**
   * NIP-09 の `e` タグに対応する削除。削除件数を返す（エラー時 0）。
   *
   * 呼び出し側は保存行を見られないため、実装が 2 つの規則を保証すること:
   * **`pubkey` が一致する行のみ削除する**、**kind 5 は決して削除しない**。
   */
  deleteEventsByIdsForPubkey(ids: string[], pubkey: string): Promise<number>;

  /**
   * NIP-09 の `a` タグに対応する削除。`created_at <= until` の版のみを削除し、削除件数を
   * 返す（エラー時 0）。リクエストより後に公開された版は残る。
   *
   * 通常 kind の座標（`1:<pubkey>:`）は「この著者の kind 1 を全削除」になり、非有限の
   * `until` は上限そのものを外すため、`isDeletableAddress` で両方を弾くこと。公開
   * メソッドなので、この防御を削除リクエストのパーサ側だけに置くことはできない。
   */
  deleteEventsByAddress(address: EventAddress, until: number): Promise<number>;

  /**
   * `olderThan`（Unix 秒）より前に**キャッシュへ投入された**イベントを削除し、件数を返す。
   * `priority` に一致するイベントは期限切れでも残す。TTL スイープ用の optional。
   */
  deleteExpired?(olderThan: number, priority?: CachePriority): Promise<number>;

  /**
   * 保存件数を `maxSize` 以下に切り詰め、退避件数を返す（`maxSize <= 0` は no-op）。
   *
   * `priority` に一致するイベントは最後に退避する。非優先を strategy 順に退避しても
   * まだ超過している場合は優先イベントも同じ順で退避し、`maxSize` は常に守る。
   */
  enforceLimit?(
    maxSize: number,
    strategy?: CacheStrategy,
    priority?: CachePriority
  ): Promise<number>;
}
