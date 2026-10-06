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
   * 数回で諦めず無制限になる。自分側の断線で落ちた一時接続を繋ぎ直すまでの間にも使う。
   */
  reconnectMaxDelay?: number;
  /** 宛先付きの購読で同時に開く一時接続の上限。既定 16 */
  maxTemporaryRelays?: number;
  /** 一時接続のリレーが落ちたとき、宛先の候補から外しておく時間 (ms)。既定 600000 */
  temporaryRelayCooldown?: number;
  /**
   * 構築時ではなく `start()` 時に 1 回評価する。ブラウザでエミュレータがグローバルを
   * 差し替えたあとでも差し替え前の `WebSocket` へ届き、横取り URL を上流に指定した
   * ときの自己接続ループを防ぐため。既定 `() => globalThis.WebSocket`
   */
  webSocketFactory?: () => typeof WebSocket;
}
