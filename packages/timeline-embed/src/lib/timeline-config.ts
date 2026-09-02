/**
 * ウィジェットの文字列入力（属性・クエリパラメータ）を型付きの設定へ変換する。
 * カスタム要素と iframe ページで解釈を 1 つにするため、すべて純粋関数。
 * JSON の `filters` だけは量があるので `filter-json.ts` に分けている。
 */

import type { Filter } from '@nostr-cache/shared';
import {
  type AuthorAction,
  type EventAction,
  type NoteAction,
  normalizeActions,
  normalizeAuthorAction,
  normalizeNoteAction,
} from './event-actions.ts';
import { parseFilterList, toPubkeyHex } from './filter-json.ts';
import { type MaterialVariant, parseMaterialVariant } from './material-symbols.ts';
import { MAX_REACTIONS } from './reactions.ts';
import { MAX_REPLIES, MAX_REPLY_DEPTH } from './reply-tree.ts';

export const DEFAULT_LIMIT = 50;
/** Reposts included: a real client's home timeline is notes and reposts. */
export const DEFAULT_KINDS = [1, 6];

function splitList(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * https ページで `ws://` を弾くのは、ブラウザが混在コンテンツとして遮断するため。
 * 後で静かに失敗させるより、理由を説明できるここで落とす。
 */
export function parseRelays(value: string | null | undefined): string[] {
  const secureContext = typeof location !== 'undefined' && location.protocol === 'https:';
  const relays: string[] = [];

  for (const entry of splitList(value)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      console.warn(`[nostr-timeline] Ignoring malformed relay URL: ${entry}`);
      continue;
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      console.warn(`[nostr-timeline] Ignoring non-WebSocket relay URL: ${entry}`);
      continue;
    }
    if (secureContext && url.protocol === 'ws:') {
      console.warn(
        `[nostr-timeline] Ignoring ${entry}: an https page cannot open a ws:// upstream (mixed content). Use wss://.`
      );
      continue;
    }
    relays.push(entry);
  }

  return [...new Set(relays)];
}

function parseNumberList(value: string | null | undefined): number[] {
  const numbers: number[] = [];
  for (const entry of splitList(value)) {
    const parsed = Number(entry);
    if (Number.isInteger(parsed) && parsed >= 0) {
      numbers.push(parsed);
    } else {
      console.warn(`[nostr-timeline] Ignoring invalid kind: ${entry}`);
    }
  }
  return numbers;
}

interface WholeNumberSpec {
  /** As the embedder spelled it, so the warning names what they wrote. */
  attribute: string;
  /** Completes "Ignoring invalid <attribute> (expected …)". */
  expectation: string;
  /**
   * `0` only where the attribute spells "off" with it. Anything below the
   * minimum is a typo either way — none of these read a negative as a setting.
   */
  min: 0 | 1;
  /** 拒否ではなくクランプ。上限超えは「出せるだけ」の意思表示で、拒否すると既定値に落ちる。 */
  max?: number;
  /** Applied last, so `min` and `max` both read the attribute's own unit. */
  scale?: number;
  element: 'nostr-timeline' | 'nostr-post';
}

/** 不正な入力は警告して呼び出し側の既定値に任せる（タイポで埋め込みを壊さない）。 */
function parseWholeNumber(
  value: string | null | undefined,
  { attribute, expectation, min, max, scale = 1, element }: WholeNumberSpec
): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    console.warn(`[${element}] Ignoring invalid ${attribute} (expected ${expectation}): ${value}`);
    return undefined;
  }
  return (max === undefined ? parsed : Math.min(parsed, max)) * scale;
}

/**
 * kind 0 / kind 3 のキャッシュを上流に聞き直さずに使う秒数。
 *
 * @param label 警告に出す属性名。`follows-freshness` もここを通る
 */
export function parseFreshness(
  value: string | null | undefined,
  label = 'profile-freshness'
): number | undefined {
  return parseWholeNumber(value, {
    attribute: label,
    expectation: 'whole seconds, 0 to disable',
    min: 0,
    element: 'nostr-timeline',
  });
}

/**
 * キャッシュの上限。埋め込み先オリジンの容量を使うので、不正値は無制限ではなく既定へ倒す。
 *
 * @returns `undefined` なら `DEFAULT_STORAGE_MAX_SIZE` のまま
 */
export function parseMaxEvents(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'max-events',
    expectation: 'a whole number of events, 0 to disable',
    min: 0,
    element: 'nostr-timeline',
  });
}

/**
 * 画面が保持するイベント数（= どこまで遡れるか）。IndexedDB を縛る `max-events` とは別。
 *
 * @returns `0` は `Infinity`、`undefined` なら `DEFAULT_TIMELINE_CAP` のまま
 */
export function parseMaxTimelineEvents(value: string | null | undefined): number | undefined {
  const parsed = parseWholeNumber(value, {
    attribute: 'max-timeline-events',
    expectation: 'a whole number of events, 0 for no ceiling',
    min: 0,
    element: 'nostr-timeline',
  });
  return parsed === 0 ? Number.POSITIVE_INFINITY : parsed;
}

interface ProxyAttribute {
  attribute: 'ogp-proxy' | 'image-proxy';
  /** 「URL が要る」警告の後半。用途と書き方の例。 */
  missing: string;
  /** 資格情報つきの URL を使えない理由。 */
  credentials: string;
}

const OGP_PROXY: ProxyAttribute = {
  attribute: 'ogp-proxy',
  missing:
    'it needs the proxy to fetch through, e.g. ogp-proxy="https://corsproxy.io/?key=YOUR_API_KEY"',
  credentials: 'which a CORS request cannot carry',
};

const IMAGE_PROXY: ProxyAttribute = {
  attribute: 'image-proxy',
  missing:
    'it needs the proxy to load images through, e.g. image-proxy="https://nostr-image-optimizer.ocknamo.com/image"',
  credentials: 'which an image request cannot carry',
};

/** 属性なし・`false`・`0` は無効。URL の無い指定だけは、書き間違いとみなして警告する。 */
function parseProxyUrl(
  value: string | boolean | null | undefined,
  { attribute, missing, credentials }: ProxyAttribute
): string | undefined {
  if (value === null || value === undefined || value === false) {
    return undefined;
  }
  // Svelte の親がプロパティで渡すと `true` が来る。URL が無いので属性なしと同じ警告へ。
  const proxy = value === true ? '' : value.trim();
  if (proxy === 'false' || proxy === '0') {
    return undefined;
  }
  if (proxy === '' || proxy === 'true' || proxy === '1') {
    console.warn(`[nostr-timeline] Ignoring ${attribute} without a URL: ${missing}.`);
    return undefined;
  }
  // `new URL` は `off` のようなタイポを埋め込みページ基準で解決して使えそうな URL を返すため、
  // パースより先に見る。
  if (!/^https?:\/\//i.test(proxy) && !proxy.startsWith('/')) {
    console.warn(
      `[nostr-timeline] Ignoring ${attribute} (expected an https:// URL, or a path on this origin): ${value}`
    );
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(proxy, typeof location === 'undefined' ? undefined : location.href);
  } catch {
    console.warn(`[nostr-timeline] Ignoring malformed ${attribute}: ${value}`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[nostr-timeline] Ignoring non-http(s) ${attribute}: ${value}`);
    return undefined;
  }
  if (url.username || url.password) {
    console.warn(
      `[nostr-timeline] Ignoring ${attribute} with credentials in it, ${credentials}: ${value}`
    );
    return undefined;
  }
  if (
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    url.protocol === 'http:'
  ) {
    console.warn(
      `[nostr-timeline] Ignoring ${value}: an https page cannot reach an http:// proxy (mixed content). Use https://.`
    );
    return undefined;
  }
  // パスの解決をリクエストごとに繰り返さないよう、解決後の URL を返す。
  return url.href;
}

/**
 * OGP 取得に使う CORS プロキシ。未指定なら機能ごと無効で、閲覧者の情報は第三者に渡らない。
 * 既定のプロキシを用意しないのは、誰の API キーも持たず誰かのクォータを使うことになるため。
 */
export function parseOgpProxy(value: string | boolean | null | undefined): string | undefined {
  return parseProxyUrl(value, OGP_PROXY);
}

/**
 * 添付画像・アバター・OGP サムネイルを通す画像最適化プロキシ。未指定なら投稿者が書いた
 * URL から直接読み込む。既定を置かないのは、全閲覧者の IP をそのホストに送ることになるため。
 */
export function parseImageProxy(value: string | boolean | null | undefined): string | undefined {
  const proxy = parseProxyUrl(value, IMAGE_PROXY);
  if (proxy === undefined) {
    return undefined;
  }
  // `ogp-proxy` と違い、この URL の後ろには寸法と元の URL がパスとして続く。
  // クエリがあるとその全部がクエリ側に落ちて、警告も出ないまま壊れた要求になる。
  const url = new URL(proxy);
  if (url.search || url.hash) {
    console.warn(
      `[nostr-timeline] Ignoring image-proxy with a query or fragment, which the resized path would end up inside: ${value}`
    );
    return undefined;
  }
  return proxy;
}

/**
 * オプトインの真偽属性。裸（空文字）・`"true"`・`"1"` で有効、他は無効。
 * Svelte の親はプロパティで渡すので boolean も受ける。既定 on 側は {@link parseEnabled}。
 */
export function parseFlag(value: string | boolean | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'true' || normalized === '1';
}

/** `cache` / `upstream` バッジは埋め込む側が動作確認に使うものなので、既定は off。 */
export function parseDebug(value: string | boolean | null | undefined): boolean {
  return parseFlag(value);
}

/** Keeps the `show-origin` deprecation notice to one line per page. */
let showOriginWarned = false;

/**
 * 非推奨の `show-origin`。バッジを **on にすることしかできない**。
 * 属性が無い場合を「on」と扱うと、この属性から離れた新しい既定に戻ってしまうため。
 */
export function parseShowOriginAlias(value: string | boolean | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (!showOriginWarned) {
    showOriginWarned = true;
    console.warn(
      '[nostr-timeline] show-origin is deprecated; use debug to render the cache/upstream badges. They are hidden by default now.'
    );
  }
  return parseDebug(value);
}

export interface FilterInput {
  /**
   * JSON array of NIP-01 filters. When it parses to at least one usable filter
   * the three fields below are ignored — see {@link parseFilters}.
   */
  filters?: string | null;
  kinds?: string | null;
  authors?: string | null;
  limit?: string | null;
}

/**
 * Build the NIP-01 filter for the timeline subscription.
 *
 * Omitted or unparseable inputs fall back to the defaults (kinds 1 and 6,
 * 50 events) so a bare `<nostr-timeline>` still shows something.
 */
export function parseFilter(input: FilterInput): Filter {
  const kinds = parseNumberList(input.kinds);
  const authors = splitList(input.authors);
  const parsedLimit = Number(input.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;

  const filter: Filter = {
    kinds: kinds.length > 0 ? kinds : DEFAULT_KINDS,
    limit,
  };
  if (authors.length > 0) {
    filter.authors = authors;
  }
  return filter;
}

/** Keeps the `filters` precedence notice to one line per page. */
let filtersPrecedenceWarned = false;

/**
 * 使える `filters` があればそちらが勝つ。`kinds` / `authors` / `limit` では書けない
 * ことを表現できるので、混ぜると埋め込む側が書いていないクエリになる。
 * JSON が全滅した場合も含め、狭い属性の側がフォールバック。
 */
export function parseFilters(input: FilterInput): Filter[] {
  const filters = parseFilterList(input.filters);
  if (!filters) {
    return [parseFilter(input)];
  }
  if (!filtersPrecedenceWarned && (input.kinds || input.authors || input.limit)) {
    filtersPrecedenceWarned = true;
    console.warn('[nostr-timeline] filters is set; ignoring kinds, authors and limit.');
  }
  // limit 無しだとページを開くたびにキャッシュ全件 + 上流への同じ要求になる。
  return filters.map((filter) =>
    filter.limit === undefined ? { ...filter, limit: DEFAULT_LIMIT } : filter
  );
}

/**
 * hex / `npub` / `nprofile` を受ける。他の属性と違い既定値で代替できない
 * （フォールバックできるフォローリストが無い）ため、呼び出し側が閲覧者に表示する。
 */
export function parsePubkey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const hex = toPubkeyHex(value.trim());
  if (!hex) {
    console.warn(`[nostr-timeline] Invalid pubkey (expected hex, npub or nprofile): ${value}`);
  }
  return hex;
}

export function parseKinds(value: string | null | undefined): number[] {
  const kinds = parseNumberList(value);
  return kinds.length > 0 ? kinds : DEFAULT_KINDS;
}

export function parseLimit(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

/**
 * `authors` に載せるフォロー数の上限。0 を「誰もフォローしない」と読まず弾くのは、
 * authors 空の購読になってしまうため。`undefined` なら `DEFAULT_MAX_FOLLOWS` のまま。
 */
export function parseMaxFollows(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'max-follows',
    expectation: 'a positive whole number',
    min: 1,
    element: 'nostr-timeline',
  });
}

/** The optional recency bound on a follow timeline, in seconds. */
export function parseSinceDays(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'since-days',
    expectation: 'a positive whole number of days',
    min: 1,
    scale: 86_400,
    element: 'nostr-timeline',
  });
}

/** `show-avatars` / `show-media` のような、明示的に off にしない限り on の属性。 */
export function parseEnabled(value: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return value !== 'false';
}

/** Reactions to backfill for one post, clamped at what the widget can hold. */
export function parseReactionsLimit(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'reactions-limit',
    expectation: 'a positive whole number',
    min: 1,
    max: MAX_REACTIONS,
    element: 'nostr-post',
  });
}

/**
 * Backfill size for **one level** of a thread, not for the thread as a whole:
 * every level asks for its own, so a deep thread is allowed more than this.
 */
export function parseRepliesLimit(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'replies-limit',
    expectation: 'a positive whole number',
    min: 1,
    max: MAX_REPLIES,
    element: 'nostr-post',
  });
}

/**
 * 開く階層数（直接の返信を 1 と数える）。上限があるのは礼儀ではなく、階層ごとに
 * ライブ購読を 1 本使い、リレーの上限 20 のうち 8 本は既に他で使っているため。
 */
export function parseRepliesDepth(value: string | null | undefined): number | undefined {
  return parseWholeNumber(value, {
    attribute: 'replies-depth',
    expectation: 'a positive whole number',
    min: 1,
    max: MAX_REPLY_DEPTH,
    element: 'nostr-post',
  });
}

/**
 * iframe の URL クエリから設定を読む。カスタム要素の属性と同じものを同じ名前で受ける。
 * 省略可能な値の `undefined` は「呼び出し側の既定のまま」を意味する。
 */
export function configFromSearchParams(params: URLSearchParams): {
  relays: string[];
  filters: Filter[];
  dbName: string | undefined;
  profileFreshness: number | undefined;
  followsFreshness: number | undefined;
  maxEvents: number | undefined;
  infiniteScroll: boolean;
  maxTimelineEvents: number | undefined;
  debug: boolean;
  showAvatars: boolean;
  showMedia: boolean;
  showEmbeds: boolean;
  ogpProxy: string | undefined;
  imageProxy: string | undefined;
  actions: EventAction[];
  authorAction: AuthorAction | undefined;
  noteAction: NoteAction | undefined;
  materialIcons: MaterialVariant | undefined;
  materialIconsFont: string | undefined;
} {
  return {
    relays: parseRelays(params.get('relays')),
    filters: parseFilters({
      filters: params.get('filters'),
      kinds: params.get('kinds'),
      authors: params.get('authors'),
      limit: params.get('limit'),
    }),
    dbName: params.get('db-name') ?? undefined,
    profileFreshness: parseFreshness(params.get('profile-freshness')),
    followsFreshness: parseFreshness(params.get('follows-freshness'), 'follows-freshness'),
    maxEvents: parseMaxEvents(params.get('max-events')),
    infiniteScroll: parseEnabled(params.get('infinite-scroll')),
    maxTimelineEvents: parseMaxTimelineEvents(params.get('max-timeline-events')),
    debug: parseDebug(params.get('debug')) || parseShowOriginAlias(params.get('show-origin')),
    showAvatars: params.get('show-avatars') !== 'false',
    showMedia: params.get('show-media') !== 'false',
    showEmbeds: params.get('show-embeds') !== 'false',
    ogpProxy: parseOgpProxy(params.get('ogp-proxy')),
    imageProxy: parseImageProxy(params.get('image-proxy')),
    actions: normalizeActions(params.get('actions')),
    authorAction: normalizeAuthorAction(
      params.get('author-action'),
      params.get('author-action-label')
    ),
    noteAction: normalizeNoteAction(params.get('note-action'), params.get('note-action-label')),
    materialIcons: parseMaterialVariant(params.get('material-icons')),
    materialIconsFont: params.get('material-icons-font') ?? undefined,
  };
}

export interface FollowTimelineConfig {
  relays: string[];
  pubkey: string | undefined;
  kinds: number[];
  limit: number;
  maxFollows: number | undefined;
  includeSelf: boolean;
  sinceSeconds: number | undefined;
  dbName: string | undefined;
  profileFreshness: number | undefined;
  followsFreshness: number | undefined;
  maxEvents: number | undefined;
  infiniteScroll: boolean;
  maxTimelineEvents: number | undefined;
  debug: boolean;
  showAvatars: boolean;
  showMedia: boolean;
  showEmbeds: boolean;
  ogpProxy: string | undefined;
  imageProxy: string | undefined;
  actions: EventAction[];
  authorAction: AuthorAction | undefined;
  noteAction: NoteAction | undefined;
  materialIcons: MaterialVariant | undefined;
  materialIconsFont: string | undefined;
}

/**
 * {@link configFromSearchParams} の分岐にしないのは、クエリ文字列が要素の種別を運ばず、
 * 単一の入口だとどちらのウィジェットか推測することになるため（推測を外すと、その要素に
 * 無いパラメータを黙って捨てる）。
 */
export function followConfigFromSearchParams(params: URLSearchParams): FollowTimelineConfig {
  return {
    relays: parseRelays(params.get('relays')),
    pubkey: parsePubkey(params.get('pubkey')),
    kinds: parseKinds(params.get('kinds')),
    limit: parseLimit(params.get('limit')),
    maxFollows: parseMaxFollows(params.get('max-follows')),
    includeSelf: parseEnabled(params.get('include-self')),
    sinceSeconds: parseSinceDays(params.get('since-days')),
    dbName: params.get('db-name') ?? undefined,
    profileFreshness: parseFreshness(params.get('profile-freshness')),
    followsFreshness: parseFreshness(params.get('follows-freshness'), 'follows-freshness'),
    maxEvents: parseMaxEvents(params.get('max-events')),
    infiniteScroll: parseEnabled(params.get('infinite-scroll')),
    maxTimelineEvents: parseMaxTimelineEvents(params.get('max-timeline-events')),
    debug: parseDebug(params.get('debug')),
    showAvatars: params.get('show-avatars') !== 'false',
    showMedia: params.get('show-media') !== 'false',
    showEmbeds: params.get('show-embeds') !== 'false',
    ogpProxy: parseOgpProxy(params.get('ogp-proxy')),
    imageProxy: parseImageProxy(params.get('image-proxy')),
    actions: normalizeActions(params.get('actions')),
    authorAction: normalizeAuthorAction(
      params.get('author-action'),
      params.get('author-action-label')
    ),
    noteAction: normalizeNoteAction(params.get('note-action'), params.get('note-action-label')),
    materialIcons: parseMaterialVariant(params.get('material-icons')),
    materialIconsFont: params.get('material-icons-font') ?? undefined,
  };
}
