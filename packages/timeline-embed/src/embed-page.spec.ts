import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The iframe host page configures the widget by copying query parameters onto
 * the custom element, from a list it hardcodes. That list is the one place a new
 * attribute can be forgotten: the element would accept it, the README would
 * document it, and only the iframe embed would silently ignore it. So compare
 * the two lists rather than trusting them to stay in step.
 */
describe('iframe host page', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  /** Attribute names the custom element declares in `<svelte:options>`. */
  function declaredAttributes(): string[] {
    const source = read('./nostr-timeline.svelte');
    const options = source.slice(0, source.indexOf('</svelte:options>'));
    return [...options.matchAll(/attribute: '([^']+)'/g)].map((match) => match[1]);
  }

  /** Names the host page copies from the query string onto the element. */
  function forwardedAttributes(): string[] {
    const source = read('../public/embed/index.html');
    const list = source.slice(source.indexOf('['), source.indexOf('].forEach'));
    return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  }

  it('forwards every attribute the custom element declares', () => {
    const declared = declaredAttributes();

    expect(declared.length).toBeGreaterThan(0);
    expect(forwardedAttributes()).toEqual(expect.arrayContaining(declared));
  });

  it('forwards nothing the element would ignore', () => {
    expect(declaredAttributes()).toEqual(expect.arrayContaining(forwardedAttributes()));
  });
});
