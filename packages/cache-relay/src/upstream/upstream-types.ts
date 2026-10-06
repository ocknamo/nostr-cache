/** 上流リレー層の型。層の役割は doc/cache-relay/upstream.md を参照。 */

import type { Filter, NostrEvent } from '@nostr-cache/shared';

/**
 * 実装は {@link UpstreamRelayPool}。テストはモックを差し込んで
 * {@link UpstreamCoordinator} を実ソケット無しで動かす。
 *
 * `upstreamSubId` は呼び出し側（coordinator）が採番する。NIP-01 の 64 文字制限が
 * あるため、クライアントの購読 id を連結せず短い id と対応表で持つ。
 */
export interface UpstreamPool {
  /** 接続の開始だけを待つ。個々のリレーは背後で接続するので、落ちていても reject しない。 */
  start(): Promise<void>;

  stop(): Promise<void>;

  /** fire-and-forget。切断中のリレーへの分は捨てられる（再送キューは無い）。 */
  publish(event: NostrEvent): void;

  /**
   * `relays` を渡すと既定の上流ではなくそれらだけに REQ を送り（未接続なら一時接続）、
   * EOSE もそれらを待つ。届かないと分かっているリレーは除き、残りが無ければ即 EOSE。
   */
  openSubscription(upstreamSubId: string, filters: Filter[], relays?: string[]): void;

  /** 宛先付きの購読で使えるか（落ちて冷却中でない・一時接続の枠がある）。 */
  canReach?(relayUrl: string): boolean;

  /** 自分側が繋がっていないか。真のあいだは読み込みを振り分けない。 */
  isOffline?(): boolean;

  /**
   * 既定の上流以外のリレーへ 1 回送る（アウトボックス）。冷却中の宛先は飛ばし、繋がらなかった
   * 宛先は読み込みの宛先からも外す。無いプールではリレー本体が自前で送る。
   */
  publishTo?(event: NostrEvent, relays: string[]): void;

  closeSubscription(upstreamSubId: string): void;

  /** 届くのは未検証の生イベント。 */
  onEvent(callback: (upstreamSubId: string, event: NostrEvent, relayUrl: string) => void): void;

  /**
   * 待つ相手が全員 EOSE を返すか諦めたら 1 回だけ発火（0 台なら即座に）。待つのは、既定の
   * 購読では開いた時点で接続済みのリレー（落ちているリレーに集約を止めさせない）、宛先付きでは宛先。
   */
  onEose(callback: (upstreamSubId: string) => void): void;

  getConnectedCount(): number;
}

export interface UpstreamPoolOptions {
  /** 超えた URL は警告して無視する。既定 `DEFAULT_MAX_CONCURRENT_RELAYS` */
  maxRelays?: number;
  /** 再接続の指数バックオフの初回待ち時間 (ms)。既定 1000 */
  reconnectBaseDelay?: number;
  /**
   * バックオフを使い切ったあと再武装するまでの待ち時間 (ms)。既定 60000。これがあるため再接続は
   * 数回で諦めず無制限になる。自分側の断線で落ちた一時接続を送り直すまでの間にも使う。
   */
  reconnectMaxDelay?: number;
  /** 宛先付きの購読で同時に開く一時接続の上限。既定 16 */
  maxTemporaryRelays?: number;
  /** 一時接続のリレーが落ちたとき、宛先の候補から外しておく時間 (ms)。既定 600000 */
  temporaryRelayCooldown?: number;
  /**
   * 構築時ではなく接続を作るときに評価する。ブラウザでエミュレータがグローバルを差し替えた
   * あとでも差し替え前の `WebSocket` へ届き、横取り URL を上流に指定したときの自己接続ループを
   * 防ぐため。既定 `() => globalThis.WebSocket`
   */
  webSocketFactory?: () => typeof WebSocket;
}
