// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureIconFont, relayConfigFrom, viewPropsFrom } from './embed-props.ts';

describe('relayConfigFrom', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the unset settings undefined, so the host keeps its own defaults', () => {
    expect(relayConfigFrom({})).toEqual({
      upstreamRelays: [],
      dbName: undefined,
      profileFreshness: undefined,
      followsFreshness: undefined,
      storageMaxSize: undefined,
    });
  });

  it('reads the attributes the host is configured with', () => {
    expect(
      relayConfigFrom({
        relays: 'wss://relay.example, wss://other.example',
        dbName: 'embed-cache',
        profileFreshness: '60',
        followsFreshness: '30',
        maxEvents: '250',
      })
    ).toEqual({
      upstreamRelays: ['wss://relay.example', 'wss://other.example'],
      dbName: 'embed-cache',
      profileFreshness: 60,
      followsFreshness: 30,
      storageMaxSize: 250,
    });
  });

  it('warns under the attribute name the embedder wrote', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    relayConfigFrom({ followsFreshness: 'いつか' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('follows-freshness'));
  });
});

describe('viewPropsFrom', () => {
  it('renders everything and presses nowhere until asked', () => {
    expect(viewPropsFrom({})).toEqual({
      showAvatars: true,
      showMedia: true,
      showEmbeds: true,
      ogpProxy: undefined,
      imageProxy: undefined,
      actions: [],
      authorAction: undefined,
      noteAction: undefined,
      materialIcons: undefined,
    });
  });

  it('takes only the exact "false" as off, as the attributes are documented', () => {
    const view = viewPropsFrom({ showAvatars: 'false', showMedia: 'no', showEmbeds: 'FALSE' });

    expect(view.showAvatars).toBe(false);
    expect(view.showMedia).toBe(true);
    expect(view.showEmbeds).toBe(true);
  });

  it('carries the image proxy through, resolved once', () => {
    const view = viewPropsFrom({ imageProxy: 'https://optimizer.example/image' });

    expect(view.imageProxy).toBe('https://optimizer.example/image');
  });

  it('pairs each press with its own label attribute', () => {
    const view = viewPropsFrom({
      actions: '[{"id":"like","label":"よい"}]',
      authorAction: 'open-profile',
      authorActionLabel: '著者を開く',
      noteAction: 'open-note',
      noteActionLabel: '引用を開く',
      materialIcons: 'rounded',
    });

    expect(view.actions).toEqual([{ id: 'like', label: 'よい' }]);
    expect(view.authorAction).toEqual({ id: 'open-profile', label: '著者を開く' });
    expect(view.noteAction).toEqual({ id: 'open-note', label: '引用を開く' });
    expect(view.materialIcons).toBe('rounded');
  });
});

describe('ensureIconFont', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('loads the font the icons need', () => {
    ensureIconFont('outlined');

    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
  });

  it('loads nothing for a page that carries the font itself', () => {
    ensureIconFont('outlined', 'none');

    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
  });

  it('loads nothing when the icons are plain text', () => {
    ensureIconFont(undefined);

    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0);
  });
});
