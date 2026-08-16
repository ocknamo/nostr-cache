/**
 * Squashes a note body down to the single line a reference chip has room for.
 *
 * Deliberately not part of `content-parts.ts`, whose contract is that it only
 * classifies ranges of the string it was given. Everything here *synthesises*
 * text the author never wrote — `[画像]` for an attachment, `@name` for a
 * mention, an ellipsis for the tail it dropped — and it needs profiles to do
 * it, which would hand the tokenizer a dependency it does not have.
 */

import type { NostrEvent } from '@nostr-cache/shared';
import { type EntityPart, type MediaKind, parseContent } from './content-parts.ts';
import { type Profile, stripUnrenderable } from './profile.ts';

/**
 * Code points kept before the ellipsis.
 *
 * Not the visual cut — the chip is one line and CSS ellipsizes it at whatever
 * width the card happens to have. This is the cost ceiling: without it a 100 KB
 * note becomes a 100 KB text node and a 100 KB `title` attribute on every card
 * that replies to it.
 */
export const PREVIEW_MAX_LENGTH = 140;

/**
 * Characters of the body that are tokenized at all.
 *
 * A token cut in half at this boundary degrades to plain text, which is past
 * {@link PREVIEW_MAX_LENGTH} and therefore discarded anyway.
 */
const PREVIEW_SOURCE_LIMIT = 2000;

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: '[画像]',
  video: '[動画]',
  audio: '[音声]',
};

/**
 * Kinds whose `content` is not prose: a serialized event (NIP-18 reposts) or
 * ciphertext (NIP-04), both of which flatten to a line of noise.
 */
const OPAQUE_KINDS = new Set([4, 6, 16]);

export interface PreviewOptions {
  /** Profiles the widget has already fetched, to name a mention's author. */
  profiles?: ReadonlyMap<string, Profile>;
  maxLength?: number;
}

/**
 * What to show for a mention.
 *
 * `@name` when the author is already known to this timeline, the abbreviated
 * bech32 otherwise. Event and address references have no name to resolve, so
 * they always read as the abbreviated entity.
 *
 * Shared with `NoteContent.svelte` so a mention reads the same in a body and in
 * the one-line preview of that same body.
 */
export function mentionLabel(part: EntityPart, profiles?: ReadonlyMap<string, Profile>): string {
  const { entity } = part;
  if (entity.type === 'npub' || entity.type === 'nprofile') {
    const profile = profiles?.get(entity.pubkey);
    const name = profile?.displayName ?? profile?.name;
    if (name) {
      return `@${name}`;
    }
  }
  return part.label;
}

/**
 * Cut a string at a UTF-16 index without splitting a surrogate pair.
 *
 * The pair's low half would be dropped and the high half left behind, which is
 * a lone surrogate: `�` on screen, and an ill-formed string in the `title` and
 * `aria-label` built from it.
 */
function sliceWhole(value: string, end: number): string {
  const cut = value.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Keep the first `max` code points, marking the cut.
 *
 * Code points rather than UTF-16 units, for the reason {@link sliceWhole}
 * gives. Not grapheme clusters (`Intl.Segmenter`): the worst that costs is a
 * ZWJ sequence coming apart into the emoji it was built from, which is a far
 * smaller price than the cut being wrong for every non-BMP character.
 */
function truncate(line: string, max: number): string {
  if (line.length <= max) {
    return line;
  }
  const chars = [...line];
  if (chars.length <= max) {
    return line;
  }
  return `${chars.slice(0, max).join('')}…`;
}

/**
 * Flatten a note body onto one line.
 *
 * @returns The line, or an empty string when nothing renderable survives — a
 *   body of nothing but whitespace, or an empty one
 */
export function notePreview(content: string, options: PreviewOptions = {}): string {
  const { profiles, maxLength = PREVIEW_MAX_LENGTH } = options;
  const parts = parseContent(sliceWhole(content, PREVIEW_SOURCE_LIMIT));
  const line = parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.text;
        case 'link':
          // The host alone. A URL is most of a line on its own and says less
          // about the post than the words around it do.
          return new URL(part.href).hostname;
        case 'media':
          return MEDIA_LABELS[part.media];
        case 'entity':
          return mentionLabel(part, profiles);
      }
    })
    .join('');

  // Collapsing before stripping is what turns a newline into a space rather
  // than deleting it: `stripUnrenderable` would take the newline out and leave
  // the last word of one line joined to the first word of the next.
  return truncate(stripUnrenderable(line.replace(/\s+/g, ' ')).trim(), maxLength);
}

/**
 * {@link notePreview} of an event, skipping {@link OPAQUE_KINDS}.
 *
 * A repost carries the reposted event's JSON in `content`, which flattens to a
 * line of punctuation and field names. Better to show nothing and let the
 * caller fall back to whatever it shows for an unresolved reference.
 */
export function eventPreview(event: NostrEvent, options: PreviewOptions = {}): string {
  if (OPAQUE_KINDS.has(event.kind)) {
    return '';
  }
  return notePreview(event.content, options);
}
