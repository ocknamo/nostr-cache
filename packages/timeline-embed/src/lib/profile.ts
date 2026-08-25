/**
 * Parses kind 0 (NIP-01 profile metadata) into the handful of fields the
 * timeline renders.
 *
 * Everything here treats the event content as hostile input: it arrives as an
 * arbitrary JSON string from an upstream relay, and — because the widget runs
 * with lazy validation — it may not even have a verified signature yet when it
 * first reaches the UI. So every field is checked for type, clamped for length,
 * and (for `picture`) restricted to a scheme that is safe to put in an
 * `<img src>`.
 */

/** Longest name / handle we will render before treating the value as junk. */
const MAX_NAME_LENGTH = 128;
/** Longest URL we will accept. Comfortably above any real avatar URL. */
const MAX_URL_LENGTH = 512;
/**
 * Characters that must never reach the card: C0/C1 controls (a newline in a
 * name would break the single-line layout) and the bidi overrides, which can
 * reorder the text around a name and make it read as something else.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const UNRENDERABLE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export interface Profile {
  /** NIP-01 `name` — the short handle, rendered as `@name`. */
  name?: string;
  /** NIP-01 `display_name` — the human-facing name, preferred for the title. */
  displayName?: string;
  /** Avatar URL. Only `http:` / `https:` survive parsing. */
  picture?: string;
  /**
   * NIP-05 identifier, exactly as published.
   *
   * **Not verified.** Confirming it needs a `.well-known/nostr.json` lookup
   * against the claimed domain, which this package does not do — so this is an
   * unchecked claim by the author and the timeline does not render it.
   */
  nip05?: string;
}

/**
 * Drop everything from {@link UNRENDERABLE}.
 *
 * Exported for `content-preview.ts`, which needs this wide set — the same one a
 * name needs — rather than the narrower one `content-parts.ts` applies to a
 * body. It cannot reuse {@link safeText} instead: that one *rejects* text over
 * its limit where a preview truncates, and it strips before anything has had a
 * chance to collapse the whitespace, which would glue the lines of a note
 * together into one word.
 */
export function stripUnrenderable(value: string): string {
  return value.replace(UNRENDERABLE, '');
}

/**
 * Read a string field, rejecting non-strings and anything implausibly long.
 *
 * Control characters are stripped rather than rejected: a name is rendered on
 * one line, and a newline or a bidi override in it would let an author reshape
 * the card around their own text.
 *
 * Exported because `reactions.ts` reads strings out of an event the same way
 * and for the same reason — a reaction's content is rendered inline in a chip,
 * where a bidi override would reorder the text around it. Sharing the one
 * implementation is what keeps the two from drifting apart.
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
 * Exported for `reactions.ts`: a NIP-30 custom emoji is an author-supplied
 * image URL that ends up in an `<img src>` exactly like an avatar does, so it
 * has to clear the same bar.
 *
 * @param maxLength Overrides the avatar-sized ceiling. `ogp.ts` raises it: an
 *   OGP image is routinely a generated URL carrying a title and a signature in
 *   its query string, which an avatar URL never is.
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
  // The parsed form, not the raw string: `new URL()` drops embedded tabs and
  // newlines, so the two can differ and only one of them was validated.
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

  // An object with none of the fields we render is indistinguishable from no
  // profile at all, and returning it would suppress the pubkey fallback.
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/**
 * Abbreviate a pubkey for display.
 *
 * Used both as the author name when no profile is available and as the label
 * on a reference chip.
 */
export function shortPubkey(pubkey: string): string {
  return pubkey.length <= 16 ? pubkey : `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

/**
 * The name to render for an author.
 *
 * `display_name` is the field clients show most prominently, `name` is the
 * handle, and the shortened pubkey is what is left when neither was published
 * (or the profile has not arrived yet).
 */
export function authorName(pubkey: string, profile?: Profile): string {
  return profile?.displayName ?? profile?.name ?? shortPubkey(pubkey);
}

/**
 * The `@handle` to render next to the name, if there is one worth showing.
 *
 * Suppressed when it would merely repeat the displayed name.
 */
export function authorHandle(pubkey: string, profile?: Profile): string | undefined {
  const handle = profile?.name;
  if (!handle || handle === authorName(pubkey, profile)) {
    return undefined;
  }
  return handle;
}
