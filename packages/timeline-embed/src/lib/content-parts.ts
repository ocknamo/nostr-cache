/**
 * Turns a note's `content` into the tokens the card renders.
 *
 * The widget runs inside someone else's page and shows events that may not have
 * a verified signature yet, so the body is treated exactly as hostile as kind 0
 * is in `profile.ts`: nothing here produces markup. This module only classifies
 * *ranges of the original string*, and the component renders each range with a
 * plain Svelte interpolation — so the package keeps its "no `{@html}`, no
 * `innerHTML` anywhere" property, and there is no sanitizer to get wrong.
 *
 * What is recognised:
 * - `http(s)` URLs, which become links (other schemes stay literal text, so a
 *   `javascript:` payload is never given an `href`)
 * - URLs whose path ends in a known media extension, which become attachments
 * - NIP-19 / NIP-21 entities, with or without the `nostr:` prefix
 */

import { NIP19_PREFIXES, type Nip19Entity, decodeNip19 } from '@nostr-cache/shared';

/** Longest URL we will linkify. Well past any real link, short of a payload. */
const MAX_URL_LENGTH = 2048;
/**
 * Most attachments rendered for one note. A note listing a hundred image URLs
 * is not a gallery worth rendering, and the embedding page pays for every one.
 * Anything past the cap stays in the text as an ordinary link.
 */
const MAX_MEDIA = 8;
/**
 * Roughly the most tokens produced for one note. Past this the remainder is
 * emitted as a single text part: a pathological note should cost one text node,
 * not thousands of elements in the embedding page. The check is made between
 * matches, so the real ceiling is this plus the last match's text/token pair.
 */
const MAX_PARTS = 200;

/**
 * Bidi overrides, stripped before anything else is done with the content.
 *
 * `profile.ts` strips these from names for the same reason, but the stakes rise
 * once the body contains links: an override can reorder the text around an `<a>`
 * so the visible label belongs to one link and the href to another. Control
 * characters are *not* stripped here — unlike a name, a note body is rendered
 * with `white-space: pre-wrap` and its newlines are meaningful.
 */
const BIDI_OVERRIDES = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** bech32 の文字集合（`1`, `b`, `i`, `o` を含まない）。 */
const BECH32_CHARS = '023456789acdefghjklmnpqrstuvwxyz';

/**
 * The scanner.
 *
 * URLs stop at whitespace and at the quoting characters that cannot appear in
 * one unescaped; the over-matched tail (a sentence's full stop, a closing
 * bracket) is trimmed afterwards by `trimUrlTail`, which needs to count
 * brackets and so cannot be expressed here.
 *
 * Every alternative is a flat sequence — no nested quantifiers — so scanning
 * stays linear in the length of the content.
 */
const TOKEN_PATTERN = new RegExp(
  ['https?://[^\\s<>"\'`]+', `(?:nostr:)?(?:${NIP19_PREFIXES.join('|')})1[${BECH32_CHARS}]+`].join(
    '|'
  ),
  'gi'
);

/**
 * A character that means a match is the tail of a longer word rather than a
 * token of its own.
 *
 * Deliberately just word characters: a URL containing an entity (`https://
 * njump.me/npub1…`) is already swallowed whole by the URL alternative, so
 * punctuation like `:` and `/` must stay allowed — otherwise a mention written
 * after one (`参照:nostr:npub1…`) would be missed.
 */
const ENTITY_BOUNDARY = /[0-9a-z_]/i;

export type MediaKind = 'image' | 'video' | 'audio';

/**
 * Extensions we are willing to hand to `<img>` / `<video>` / `<audio>`.
 *
 * `.svg` is deliberately absent: an SVG is a document with a scripting surface,
 * and while `<img>` will not run its scripts, keeping it out of the list means
 * we never have to depend on that being true in every engine.
 *
 * `.ogg` is ambiguous by spec and used for both; it is filed as audio because
 * that is overwhelmingly what it carries in the wild. `.ogv` is the video one.
 */
const MEDIA_EXTENSIONS = new Map<string, MediaKind>([
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['png', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['avif', 'image'],
  ['mp4', 'video'],
  ['webm', 'video'],
  ['ogv', 'video'],
  ['mov', 'video'],
  ['mp3', 'audio'],
  ['ogg', 'audio'],
  ['oga', 'audio'],
  ['wav', 'audio'],
  ['m4a', 'audio'],
]);

/** Trailing characters that end a sentence rather than belong to a URL. */
const URL_TAIL = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '"',
  "'",
  '、',
  '。',
  '，',
  '．',
  '！',
  '？',
  '…',
  '」',
  '』',
  '”',
  '’',
  '»',
]);

/** Closing brackets, kept when the URL opens them itself. */
const URL_TAIL_BRACKETS = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
  ['）', '（'],
  ['】', '【'],
]);

export interface TextPart {
  kind: 'text';
  text: string;
}

export interface LinkPart {
  kind: 'link';
  /** The parsed, normalized URL — this is what goes in `href`. */
  href: string;
  /** The URL as the author wrote it, which is what the reader sees. */
  label: string;
}

export interface MediaPart {
  kind: 'media';
  media: MediaKind;
  /** The parsed, normalized URL. */
  url: string;
}

export interface EntityPart {
  kind: 'entity';
  /** The decoded entity, so a mention can be resolved to a name. */
  entity: Nip19Entity;
  /** The token exactly as written, `nostr:` prefix included. */
  raw: string;
  /** Abbreviated bech32, used when nothing better is known. */
  label: string;
}

export type ContentPart = TextPart | LinkPart | MediaPart | EntityPart;

/**
 * Parse a URL and keep it only if it is safe to put in an `href`.
 *
 * @returns The parsed URL, or undefined when it is malformed, too long, or not
 *   an `http(s)` one
 */
function readUrl(raw: string): URL | undefined {
  if (raw.length > MAX_URL_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // The pattern only matches `http`/`https`, but it does so case-insensitively
  // and `new URL()` normalizes, so this is the check that actually holds.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  return url;
}

/**
 * Drop the punctuation a URL picked up from the sentence around it.
 *
 * A closing bracket is kept when the URL contains its opener — Wikipedia links
 * really do end in `)`.
 */
function trimUrlTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1];
    const opener = URL_TAIL_BRACKETS.get(char);
    if (opener !== undefined) {
      const kept = raw.slice(0, end);
      const opens = kept.split(opener).length - 1;
      const closes = kept.split(char).length - 1;
      if (closes <= opens) {
        break;
      }
      end--;
      continue;
    }
    if (!URL_TAIL.has(char)) {
      break;
    }
    end--;
  }
  return raw.slice(0, end);
}

/**
 * Classify a URL by the extension of its path.
 *
 * The query string and fragment are ignored: `photo.jpg?v=2` is still a photo,
 * and `page.html?x=.jpg` is still not one.
 */
function classifyMedia(url: URL): MediaKind | undefined {
  const path = url.pathname;
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) {
    return undefined;
  }
  return MEDIA_EXTENSIONS.get(path.slice(dot + 1).toLowerCase());
}

/**
 * The identity of the event an entity points at, or undefined for a person.
 *
 * Two spellings of the same event (`note1…` and `nevent1…`) collapse onto the
 * same key, so a note referencing one event twice renders a single card. The
 * `naddr` key is NIP-01's `kind:pubkey:d`, which cannot collide with a 64-hex
 * id.
 */
export function embedKey(entity: Nip19Entity): string | undefined {
  if (entity.type === 'note' || entity.type === 'nevent') {
    return entity.id;
  }
  if (entity.type === 'naddr') {
    return `${entity.kind}:${entity.pubkey}:${entity.identifier}`;
  }
  return undefined;
}

/**
 * Shorten a bech32 string for display, keeping its prefix legible.
 *
 * `npub10elf…jptg` reads as "some npub" at a glance, which is the most a
 * mention can say before a profile arrives.
 */
export function abbreviateBech32(bech32: string): string {
  const separator = bech32.lastIndexOf('1');
  const head = bech32.slice(0, separator + 1);
  const data = bech32.slice(separator + 1);
  if (data.length <= 12) {
    return bech32;
  }
  return `${head}${data.slice(0, 4)}…${data.slice(-4)}`;
}

/** Whether a match really starts a token rather than ending a longer word. */
function startsAtBoundary(content: string, index: number): boolean {
  return index === 0 || !ENTITY_BOUNDARY.test(content[index - 1]);
}

/**
 * Split a note body into renderable parts.
 *
 * @returns The parts in source order. A note with nothing special in it yields
 *   a single text part.
 */
export function parseContent(content: string): ContentPart[] {
  const clean = content.replace(BIDI_OVERRIDES, '');
  const parts: ContentPart[] = [];
  /** Start of the text run that has not been emitted yet. */
  let textStart = 0;
  let mediaCount = 0;

  const flushText = (until: number) => {
    if (until > textStart) {
      parts.push({ kind: 'text', text: clean.slice(textStart, until) });
    }
  };

  // The pattern is a module-level `g` regex, so its `lastIndex` carries over
  // between calls; this scan owns it from here.
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(clean);
  while (match !== null && parts.length < MAX_PARTS) {
    const raw = match[0];
    const index = match.index;
    /** How much of `raw` the token actually consumed; 0 means "not a token". */
    let consumed = 0;

    if (!startsAtBoundary(clean, index)) {
      // The tail of some longer word, not a token of its own.
    } else if (/^https?:/i.test(raw)) {
      const trimmed = trimUrlTail(raw);
      const url = readUrl(trimmed);
      if (url) {
        const media = classifyMedia(url);
        flushText(index);
        if (media && mediaCount < MAX_MEDIA) {
          mediaCount++;
          parts.push({ kind: 'media', media, url: url.href });
        } else {
          // Past the attachment cap a media URL is still a perfectly good link.
          parts.push({ kind: 'link', href: url.href, label: trimmed });
        }
        consumed = trimmed.length;
      }
    } else {
      const bech32 = /^nostr:/i.test(raw) ? raw.slice(6) : raw;
      const entity = decodeNip19(bech32);
      if (entity) {
        flushText(index);
        parts.push({ kind: 'entity', entity, raw, label: abbreviateBech32(bech32.toLowerCase()) });
        consumed = raw.length;
      }
    }

    if (consumed > 0) {
      textStart = index + consumed;
    }
    // Always resume past the whole match, even when it was rejected: the tail of
    // a token that failed to decode must not be rescanned as a new one.
    TOKEN_PATTERN.lastIndex = index + Math.max(consumed, raw.length);
    match = TOKEN_PATTERN.exec(clean);
  }

  flushText(clean.length);
  return parts;
}

/**
 * Collapse the whitespace left behind where attachments were lifted out.
 *
 * A blank line is a paragraph break the author meant, so it survives; anything
 * less becomes a single newline or a single space.
 */
function collapseGap(whitespace: string): string {
  if (whitespace.length === 0) {
    return '';
  }
  const newlines = whitespace.split('\n').length - 1;
  if (newlines >= 2) {
    return '\n\n';
  }
  return newlines === 1 ? '\n' : ' ';
}

/** Merge neighbouring text, drop empty text, and trim the ends of the run. */
function normalize(parts: ContentPart[]): ContentPart[] {
  const merged: ContentPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + part.text };
      continue;
    }
    merged.push(part);
  }

  const first = merged[0];
  if (first?.kind === 'text') {
    merged[0] = { kind: 'text', text: first.text.replace(/^\s+/, '') };
  }
  const last = merged[merged.length - 1];
  if (last?.kind === 'text') {
    merged[merged.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') };
  }

  return merged.filter((part) => part.kind !== 'text' || part.text.length > 0);
}

type Lifted = (part: ContentPart) => boolean;

/**
 * Remove the parts rendered below the text, and close the hole they leave, so
 * an image — or a quoted note — on its own line does not leave a blank one.
 *
 * A whole run of lifted parts (`img1 img2 img3`) collapses to one separator
 * rather than one per part, which is why this walks forward carrying the gap's
 * whitespace rather than removing each part independently.
 */
function liftParts(parts: ContentPart[], isLifted: Lifted): ContentPart[] {
  const result: ContentPart[] = [];
  /** Whitespace around the parts removed since the last real content. */
  let gap: string | undefined;

  /** Take the whitespace trailing the text already emitted, into the gap. */
  const stealTrailingWhitespace = (): string => {
    const last = result[result.length - 1];
    if (last?.kind !== 'text') {
      return '';
    }
    const trailing = /\s+$/.exec(last.text)?.[0] ?? '';
    if (trailing) {
      result[result.length - 1] = { kind: 'text', text: last.text.slice(0, -trailing.length) };
    }
    return trailing;
  };

  for (const part of parts) {
    if (isLifted(part)) {
      // Only the first of a run has anything left to steal.
      if (gap === undefined) {
        gap = stealTrailingWhitespace();
      }
      continue;
    }

    if (part.kind === 'text') {
      if (gap === undefined) {
        result.push(part);
        continue;
      }
      const leading = /^\s+/.exec(part.text)?.[0] ?? '';
      const rest = part.text.slice(leading.length);
      gap += leading;
      // An all-whitespace part keeps the run open: the next thing may be
      // another attachment, and then this whitespace is part of the same gap.
      if (rest.length > 0) {
        result.push({ kind: 'text', text: collapseGap(gap) + rest });
        gap = undefined;
      }
      continue;
    }

    if (gap !== undefined) {
      result.push({ kind: 'text', text: collapseGap(gap) });
      gap = undefined;
    }
    result.push(part);
  }

  // A gap still open at the end is trailing whitespace, which `normalize`
  // would drop anyway.
  return normalize(result);
}

/**
 * Keyed rather than compared by token: the same event can be written as a
 * `note1…` in one place and an `nevent1…` in another, and both belong to the
 * one card.
 */
function isEmbedded(part: ContentPart, embedded: ReadonlySet<string> | undefined): boolean {
  if (part.kind !== 'entity' || !embedded) {
    return false;
  }
  const key = embedKey(part.entity);
  return key !== undefined && embedded.has(key);
}

/**
 * The parts to render inside the note's paragraph. Attachments are lifted out —
 * rendered below the text, the way a Nostr client does it — and so are the
 * entities the caller has decided to render as nested cards.
 *
 * @param embedded Keys ({@link embedKey}) of the entities rendered as cards. An
 *   entity that is not in here stays in the text as an abbreviated chip, which
 *   is what the depth and per-note caps come out as.
 */
export function inlineParts(parts: ContentPart[], embedded?: ReadonlySet<string>): ContentPart[] {
  return liftParts(parts, (part) => part.kind === 'media' || isEmbedded(part, embedded));
}

/**
 * Every attachment becomes an ordinary link, so turning media off costs the
 * reader the preview but never the URL itself. Nested cards are unaffected:
 * they cost no request to a third-party host, which is what `show-media` is
 * about.
 */
export function mediaAsLinks(parts: ContentPart[], embedded?: ReadonlySet<string>): ContentPart[] {
  const linked = parts.map((part) =>
    part.kind === 'media' ? { kind: 'link' as const, href: part.url, label: part.url } : part
  );
  return liftParts(linked, (part) => isEmbedded(part, embedded));
}

/**
 * The attachments to render below the note's text.
 *
 * A URL repeated in one note is shown once: rendering the same image twice is
 * never what the author meant, and it also keeps the list's keys unique.
 */
export function mediaParts(parts: ContentPart[]): MediaPart[] {
  const seen = new Set<string>();
  const media: MediaPart[] = [];
  for (const part of parts) {
    if (part.kind !== 'media' || seen.has(part.url)) {
      continue;
    }
    seen.add(part.url);
    media.push(part);
  }
  return media;
}
