import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The iframe host pages configure their widget by copying query parameters onto
 * the custom element, from a list each page hardcodes. That list is the one
 * place a new attribute can be forgotten: the element would accept it, the
 * README would document it, and only the iframe embed would silently ignore it.
 * So compare the two lists rather than trusting them to stay in step.
 *
 * The "forwards nothing the element would ignore" direction matters more since
 * the pages were split. Each page mounts a different element, and the two have
 * deliberately disjoint attributes (`authors` / `filters` versus `pubkey`) — so
 * a parameter copied onto the wrong one would vanish without any complaint.
 */
describe('iframe host pages', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  /** Attribute names a custom element declares in `<svelte:options>`. */
  function declaredAttributes(component: string): string[] {
    const source = read(component);
    const options = source.slice(0, source.indexOf('</svelte:options>'));
    return [...options.matchAll(/attribute: '([^']+)'/g)].map((match) => match[1]);
  }

  /** Names a host page copies from the query string onto its element. */
  function forwardedAttributes(page: string): string[] {
    const source = read(page);
    const list = source.slice(source.indexOf('mountNostrEmbed('), source.indexOf(']);'));
    return (
      [...list.matchAll(/'([^']+)'/g)]
        .map((match) => match[1])
        // The first quoted string is the tag name, not an attribute.
        .slice(1)
    );
  }

  const pages = [
    {
      what: 'embed/',
      page: '../public/embed/index.html',
      component: './nostr-timeline.svelte',
    },
    {
      what: 'embed/follow/',
      page: '../public/embed/follow/index.html',
      component: './nostr-follow-timeline.svelte',
    },
  ];

  for (const { what, page, component } of pages) {
    describe(what, () => {
      it('forwards every attribute the custom element declares', () => {
        const declared = declaredAttributes(component);

        expect(declared.length).toBeGreaterThan(0);
        expect(forwardedAttributes(page)).toEqual(expect.arrayContaining(declared));
      });

      it('forwards nothing the element would ignore', () => {
        expect(declaredAttributes(component)).toEqual(
          expect.arrayContaining(forwardedAttributes(page))
        );
      });
    });
  }

  it('mounts the element each page is for', () => {
    // The tag is the one thing the attribute comparison above cannot catch: two
    // pages forwarding correct-looking lists onto the same element would pass it
    // while leaving the follow embed rendering an ordinary timeline.
    expect(read('../public/embed/index.html')).toContain("mountNostrEmbed('nostr-timeline'");
    expect(read('../public/embed/follow/index.html')).toContain(
      "mountNostrEmbed('nostr-follow-timeline'"
    );
  });

  it('shares one height-reporting implementation between the pages', () => {
    // Splitting the entry points was only acceptable because the postMessage
    // protocol stayed in one place; a page growing its own copy is how the two
    // drift apart.
    const host = read('../public/embed/embed-host.js');
    expect(host).toContain('nostr-timeline:height');
    for (const { page } of pages) {
      expect(read(page)).toContain('embed-host.js');
      expect(read(page)).not.toContain('postMessage');
    }
  });
});
