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

export interface Profile {
  /** NIP-01 `name` — the short handle, rendered as `@name`. */
  name?: string;
  /** NIP-01 `display_name` — the human-facing name, preferred for the title. */
  displayName?: string;
  /** Avatar URL. Only `http:` / `https:` survive parsing. */
  picture?: string;
  /** NIP-05 identifier, kept for the author's `title` tooltip. */
  nip05?: string;
}

/**
 * Read a string field, rejecting non-strings and anything implausibly long.
 *
 * @returns The trimmed value, or undefined when it is unusable
 */
function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
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
 * @returns The URL, or undefined when it is missing, malformed or unsafe
 */
function readImageUrl(value: unknown): string | undefined {
  const raw = readString(value, MAX_URL_LENGTH);
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
  return raw;
}

/**
 * Parse the `content` of a kind 0 event.
 *
 * @param content Raw JSON string from the event
 * @returns The recognised fields, or undefined when nothing usable was found
 */
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
  const name = readString(record.name, MAX_NAME_LENGTH);
  const displayName =
    readString(record.display_name, MAX_NAME_LENGTH) ??
    readString(record.displayName, MAX_NAME_LENGTH);
  const picture = readImageUrl(record.picture);
  const nip05 = readString(record.nip05, MAX_NAME_LENGTH);

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
 *
 * @param pubkey Hex pubkey (or event id)
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
 *
 * @param pubkey Author's hex pubkey
 * @param profile Their profile, if one has been fetched
 */
export function authorName(pubkey: string, profile?: Profile): string {
  return profile?.displayName ?? profile?.name ?? shortPubkey(pubkey);
}

/**
 * The `@handle` to render next to the name, if there is one worth showing.
 *
 * Suppressed when it would merely repeat the displayed name.
 *
 * @param pubkey Author's hex pubkey
 * @param profile Their profile, if one has been fetched
 */
export function authorHandle(pubkey: string, profile?: Profile): string | undefined {
  const handle = profile?.name;
  if (!handle || handle === authorName(pubkey, profile)) {
    return undefined;
  }
  return handle;
}
