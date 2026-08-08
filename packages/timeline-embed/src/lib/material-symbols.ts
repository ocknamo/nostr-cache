/**
 * Material Symbols support for the card action bar.
 *
 * An action's `icon` is normally just text (an emoji, an arrow). Turning on
 * Material Symbols reinterprets it as a **ligature name** from
 * <https://fonts.google.com/icons> — `favorite`, `repeat`, `bolt` — which the
 * font renders as the icon.
 *
 * The font cannot ship inside the widget: `@font-face` declared in a shadow
 * root is ignored by every engine, so a webfont has to be registered on the
 * *document*. That leaves two ways in, and the widget supports both:
 *
 * - the embedding page loads the font itself (self-hosted, or its own `<link>`)
 *   and the widget only applies the family — `material-icons-font="none"`;
 * - the widget injects Google's stylesheet into `document.head` — the default,
 *   because a switch called "use Material icons" that renders the word
 *   `favorite` until you also hunt down a stylesheet is not a working switch.
 *   It is a third-party request that exposes the reader's IP to Google, which
 *   is why it happens only once `material-icons` is set at all.
 */

/** Variants Google publishes; the family name and the URL both follow it. */
export type MaterialVariant = 'outlined' | 'rounded' | 'sharp';

const VARIANTS: MaterialVariant[] = ['outlined', 'rounded', 'sharp'];

const FAMILIES: Record<MaterialVariant, string> = {
  outlined: 'Material Symbols Outlined',
  rounded: 'Material Symbols Rounded',
  sharp: 'Material Symbols Sharp',
};

/**
 * Read the `material-icons` switch.
 *
 * A bare attribute (or `true`) means the outlined variant, the one Google's own
 * examples use. Anything unrecognised is a typo, and rendering ligature names
 * as words would be a worse answer than leaving the icons as plain text.
 *
 * @param value Raw attribute, property or query-parameter value
 * @returns The variant to render with, or `undefined` for "plain text icons"
 */
export function parseMaterialVariant(
  value: string | boolean | null | undefined
): MaterialVariant | undefined {
  if (value === null || value === undefined || value === false) {
    return undefined;
  }
  if (value === true) {
    return 'outlined';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'true') {
    return 'outlined';
  }
  if (normalized === 'false') {
    return undefined;
  }
  if ((VARIANTS as string[]).includes(normalized)) {
    return normalized as MaterialVariant;
  }
  console.warn(
    `[nostr-timeline] Ignoring unknown material-icons variant (expected ${VARIANTS.join(' / ')}): ${value}`
  );
  return undefined;
}

/** The `font-family` a variant renders with. */
export function materialFontFamily(variant: MaterialVariant): string {
  return FAMILIES[variant];
}

/**
 * Google Fonts URL for a variant.
 *
 * The axes are requested as ranges so `--nt-material-fill` and
 * `--nt-material-weight` actually do something: a static request would pin the
 * face and leave `font-variation-settings` with nothing to vary.
 */
export function materialFontHref(variant: MaterialVariant): string {
  const family = FAMILIES[variant].replace(/ /g, '+');
  return `https://fonts.googleapis.com/css2?family=${family}:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap`;
}

/** Marks the links this module owns, so it never adds a second one. */
const LINK_ATTRIBUTE = 'data-nostr-timeline-material';

/**
 * Register a Material Symbols variant on the document, once.
 *
 * Injected into `document.head` rather than into the shadow root because a
 * shadow root's `@font-face` rules are ignored — see the module comment. The
 * link is left behind when the widget goes away: fonts are document-scoped and
 * cheap to keep, and a second widget (or a re-mount) would only have to fetch
 * it again.
 *
 * @param variant Which variant to load
 * @returns The stylesheet href, or `undefined` where there is no document
 */
export function ensureMaterialSymbols(variant: MaterialVariant): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const href = materialFontHref(variant);
  const existing = document.head.querySelector(`link[${LINK_ATTRIBUTE}="${variant}"]`);
  if (existing) {
    return href;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute(LINK_ATTRIBUTE, variant);
  document.head.appendChild(link);
  return href;
}
