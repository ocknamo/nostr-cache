// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureMaterialSymbols,
  materialFontFamily,
  materialFontHref,
  parseMaterialVariant,
} from './material-symbols.ts';

describe('parseMaterialVariant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a bare attribute as the outlined variant', () => {
    // `<nostr-timeline material-icons>` arrives as an empty string; a Svelte
    // parent setting the property delivers `true`.
    expect(parseMaterialVariant('')).toBe('outlined');
    expect(parseMaterialVariant('true')).toBe('outlined');
    expect(parseMaterialVariant(true)).toBe('outlined');
  });

  it('reads the variant Google publishes', () => {
    expect(parseMaterialVariant('outlined')).toBe('outlined');
    expect(parseMaterialVariant('rounded')).toBe('rounded');
    expect(parseMaterialVariant(' Sharp ')).toBe('sharp');
  });

  it('is off unless asked for', () => {
    expect(parseMaterialVariant(undefined)).toBeUndefined();
    expect(parseMaterialVariant(null)).toBeUndefined();
    expect(parseMaterialVariant('false')).toBeUndefined();
    expect(parseMaterialVariant(false)).toBeUndefined();
  });

  it('leaves icons as plain text when the variant is a typo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Rendering ligature names as words is worse than not switching at all.
    expect(parseMaterialVariant('outline')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('material-icons'));
  });
});

describe('materialFontHref', () => {
  it('names the family and requests the axes the CSS varies', () => {
    const href = materialFontHref('rounded');

    expect(href).toContain('family=Material+Symbols+Rounded');
    // Ranges, not fixed values: a pinned face would leave --nt-material-fill
    // and --nt-material-weight with nothing to vary.
    expect(href).toContain('opsz,wght,FILL,GRAD@');
    expect(href).toContain('0..1');
    expect(materialFontFamily('rounded')).toBe('Material Symbols Rounded');
  });
});

describe('ensureMaterialSymbols', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('registers the font on the document, where a shadow root cannot', () => {
    ensureMaterialSymbols('outlined');

    const links = document.head.querySelectorAll('link[rel="stylesheet"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(materialFontHref('outlined'));
  });

  it('adds one link per variant however many widgets ask', () => {
    ensureMaterialSymbols('outlined');
    ensureMaterialSymbols('outlined');
    ensureMaterialSymbols('sharp');

    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(2);
  });
});
