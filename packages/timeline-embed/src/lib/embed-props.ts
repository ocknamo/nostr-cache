/**
 * The attributes `<nostr-timeline>`, `<nostr-follow-timeline>` and
 * `<nostr-post>` share, and the wiring the three build from them.
 */

import {
  type AuthorAction,
  type EventAction,
  type NoteAction,
  normalizeActions,
  normalizeAuthorAction,
  normalizeNoteAction,
} from './event-actions.ts';
import {
  type MaterialVariant,
  ensureMaterialSymbols,
  parseMaterialVariant,
} from './material-symbols.ts';
import type { RelayHostConfig } from './relay-host.ts';
import { parseFreshness, parseMaxEvents, parseOgpProxy, parseRelays } from './timeline-config.ts';

/**
 * 属性の意味・既定値・注意点は packages/timeline-embed/README.md が唯一の情報源。
 * ここには型と、README では読み取れない実装上の但し書きだけを置く。
 */
export interface SharedEmbedProps {
  /** カンマ区切りの上流リレー URL。空ならキャッシュのみ。 */
  relays?: string;
  dbName?: string;
  profileFreshness?: string;
  /**
   * kind 3 を取りに行くのは `<nostr-follow-timeline>` だけ。他の要素も受け取るのは、
   * 1 ページでリレーを共有し最初に mount した側の設定が採用されるため。
   */
  followsFreshness?: string;
  maxEvents?: string;
  /** Svelte の親が裸の `debug` を渡すと属性ではなくプロパティになるので boolean も受ける。 */
  debug?: string | boolean;
  /** `"false"` で非表示。名前は取得を続けるので、止まるのは画像の読み込みだけ。 */
  showAvatars?: string;
  /** `"false"` で非表示。URL はリンクとして本文に残る。 */
  showMedia?: string;
  /** `"false"` で `nostr:` 参照を短縮チップのままにする（取得できない場合の表示と同じ）。 */
  showEmbeds?: string;
  /** 未指定・URL 無しなら**プレビュー機能ごと無効で、問い合わせも発生しない**。 */
  ogpProxy?: string;
  /**
   * JSON 配列、または JS からプロパティで渡す場合は配列そのもの（`onSelect` を持てる）。
   * ウィジェット自身は何も定義せず、押下は `nostr-timeline:action` で通知するだけ。
   */
  actions?: string | EventAction[];
  /**
   * 押された人は `detail.pubkey`。著者以外では `detail.event.pubkey` と一致しない。
   * 遷移はしない（ルータを持つのは埋め込み先ページなので）。
   */
  authorAction?: string;
  /** 押下先の説明。アクセシブル名になる。既定「プロフィールを開く」 */
  authorActionLabel?: string;
  /** `detail.event` に入るのは**引用先**の投稿。 */
  noteAction?: string;
  /** 既定「投稿を開く」 */
  noteActionLabel?: string;
  /**
   * `icon` を Material Symbols のリガチャ名として扱う。shadow root はフォントを
   * 自分で登録できないため、あわせて Google Fonts から読み込む。
   */
  materialIcons?: string | boolean;
  /** `none` なら何も読み込まず、フォントの用意は埋め込み先ページに任せる。 */
  materialIconsFont?: string;
}

/** `TimelineView` と `PostView` が共通で受け取るもの。 */
export interface SharedViewProps {
  showAvatars: boolean;
  showMedia: boolean;
  showEmbeds: boolean;
  ogpProxy?: string;
  actions: EventAction[];
  authorAction?: AuthorAction;
  noteAction?: NoteAction;
  materialIcons?: MaterialVariant;
}

export function relayConfigFrom(props: SharedEmbedProps): RelayHostConfig {
  return {
    upstreamRelays: parseRelays(props.relays),
    dbName: props.dbName || undefined,
    // 未指定は undefined のままにする。1 つのウィジェットが既定値を固定してしまうと、
    // 属性を書いていない 2 つが設定の食い違いとして扱われる。
    profileFreshness: parseFreshness(props.profileFreshness),
    followsFreshness: parseFreshness(props.followsFreshness, 'follows-freshness'),
    storageMaxSize: parseMaxEvents(props.maxEvents),
  };
}

export function viewPropsFrom(props: SharedEmbedProps): SharedViewProps {
  return {
    showAvatars: props.showAvatars !== 'false',
    showMedia: props.showMedia !== 'false',
    showEmbeds: props.showEmbeds !== 'false',
    ogpProxy: parseOgpProxy(props.ogpProxy),
    actions: normalizeActions(props.actions),
    authorAction: normalizeAuthorAction(props.authorAction, props.authorActionLabel),
    noteAction: normalizeNoteAction(props.noteAction, props.noteActionLabel),
    materialIcons: parseMaterialVariant(props.materialIcons),
  };
}

/**
 * `$effect` から、かつ {@link viewPropsFrom} でパース済みの variant で呼ぶこと。
 * `document.head` を触るので derive から呼ぶと値の読み取りが副作用を持ち、
 * 二重にパースすると警告も二重に出る。
 */
export function ensureIconFont(variant: MaterialVariant | undefined, font?: string): void {
  if (variant && font !== 'none') {
    ensureMaterialSymbols(variant);
  }
}
