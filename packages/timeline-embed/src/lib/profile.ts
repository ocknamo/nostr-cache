/**
 * kind 0 を、タイムラインが描く数フィールドへパースする。
 *
 * 内容はすべて敵性入力として扱う。上流から任意の JSON 文字列として届き、遅延検証の
 * ため UI に出る時点では署名が未検証でもありうるため。
 */

const MAX_NAME_LENGTH = 128;
const MAX_URL_LENGTH = 512;
/**
 * カードに出してはいけない文字。C0/C1 制御（名前中の改行が 1 行レイアウトを壊す）と、
 * 名前の周りのテキストを並べ替えて別物に読ませられる bidi 上書き。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const UNRENDERABLE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export interface Profile {
  /** `@name` として描く短いハンドル。 */
  name?: string;
  displayName?: string;
  /** `http:` / `https:` 以外はパース時に落とす。 */
  picture?: string;
  /**
   * **検証していない。** `.well-known/nostr.json` の照合を行わないため著者の自己申告に
   * すぎず、タイムラインには表示しない。
   */
  nip05?: string;
}

/**
 * `content-preview.ts` 向けに公開している。{@link safeText} では代用できない:
 * あちらは上限超えを切り詰めではなく**拒否**し、空白を畳む前に除去するので、
 * 投稿の複数行が 1 語に繋がってしまう。
 */
export function stripUnrenderable(value: string): string {
  return value.replace(UNRENDERABLE, '');
}

/**
 * 文字列フィールドを読む。制御文字は拒否ではなく除去する（1 行に描くため）。
 * `reactions.ts` も同じ理由で使う。実装を 1 つにしておかないと両者がずれる。
 */
export function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = stripUnrenderable(value).trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}

/**
 * Read an avatar URL, allowing only schemes that are safe to load as an image.
 *
 * `javascript:` is the obvious attack, but `data:` is excluded too: an
 * embedding page's CSP is not ours to assume, and a data URL is an easy way to
 * push a multi-megabyte payload into the DOM.
 *
 * NIP-30 のカスタム絵文字もアバターと同じく `<img src>` に入るので `reactions.ts` が使う。
 *
 * @param maxLength `ogp.ts` が引き上げる。OGP 画像はクエリにタイトルや署名を載せた
 *   生成 URL が普通で、アバター URL とは長さの前提が違う
 */
export function safeImageUrl(value: unknown, maxLength = MAX_URL_LENGTH): string | undefined {
  const raw = safeText(value, maxLength);
  if (!raw) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  // 生の文字列ではなくパース後を返す。`new URL()` はタブや改行を落とすので両者は
  // 一致せず、検証したのはパース後の方だから。
  return url.href;
}

/** Parse the `content` of a kind 0 event. */
export function parseProfileContent(content: string): Profile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const profile: Profile = {};
  const name = safeText(record.name, MAX_NAME_LENGTH);
  const displayName =
    safeText(record.display_name, MAX_NAME_LENGTH) ?? safeText(record.displayName, MAX_NAME_LENGTH);
  const picture = safeImageUrl(record.picture);
  const nip05 = safeText(record.nip05, MAX_NAME_LENGTH);

  if (name) {
    profile.name = name;
  }
  if (displayName) {
    profile.displayName = displayName;
  }
  if (picture) {
    profile.picture = picture;
  }
  if (nip05) {
    profile.nip05 = nip05;
  }

  // 描くフィールドが 1 つも無ければプロフィール無しと同じ。返すと pubkey への
  // フォールバックが効かなくなる。
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/** プロフィールが無いときの著者名と、参照チップのラベルの両方に使う。 */
export function shortPubkey(pubkey: string): string {
  return pubkey.length <= 16 ? pubkey : `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

/** `display_name` → `name` → 短縮 pubkey の順に落ちる。 */
export function authorName(pubkey: string, profile?: Profile): string {
  return profile?.displayName ?? profile?.name ?? shortPubkey(pubkey);
}

/** 表示名の繰り返しになる場合は出さない。 */
export function authorHandle(pubkey: string, profile?: Profile): string | undefined {
  const handle = profile?.name;
  if (!handle || handle === authorName(pubkey, profile)) {
    return undefined;
  }
  return handle;
}
