// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { parseContent } from '../lib/content-parts.ts';
import type { Profile } from '../lib/profile.ts';
import NoteContent from './NoteContent.svelte';

const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

describe('NoteContent', () => {
  it('renders a plain note as text', () => {
    render(NoteContent, { props: { content: 'hello there' } });

    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('links a URL without handing the target a window or a referrer', () => {
    render(NoteContent, { props: { content: 'see https://example.com/a' } });

    const link = screen.getByRole('link', { name: 'https://example.com/a' });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('target', '_blank');
    // `noopener` so the opened page cannot reach back through `window.opener`,
    // and `noreferrer` so it is not told which page the widget is embedded in.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('leaves a javascript: URL as inert text', () => {
    const { container } = render(NoteContent, { props: { content: 'click javascript:alert(1)' } });

    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.content')).toHaveTextContent('javascript:alert(1)');
  });

  it('renders an image attachment and lifts its URL out of the text', () => {
    const { container } = render(NoteContent, {
      props: { content: 'look https://cdn.example.com/a.jpg at this' },
    });

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/a.jpg');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(container.querySelector('.content')).toHaveTextContent('look at this');
  });

  it('never fetches a video or audio attachment before it is played', () => {
    const { container } = render(NoteContent, {
      props: { content: 'https://cdn.example.com/a.mp4 https://cdn.example.com/b.mp3' },
    });

    expect(container.querySelector('video')).toHaveAttribute('preload', 'none');
    expect(container.querySelector('audio')).toHaveAttribute('preload', 'none');
  });

  it('keeps the URL as a link when media is switched off', () => {
    const { container } = render(NoteContent, {
      props: { content: 'look https://cdn.example.com/a.jpg', showMedia: false },
    });

    expect(container.querySelector('img')).toBeNull();
    // Nothing is hidden: the reader still gets the URL, just not the bytes.
    expect(screen.getByRole('link', { name: 'https://cdn.example.com/a.jpg' })).toHaveAttribute(
      'href',
      'https://cdn.example.com/a.jpg'
    );
  });

  it('renders no attachment for precomputed media when media is switched off', () => {
    // `media` is an optimization for a body split into segments, not a way
    // around `show-media` — the switch is what keeps the widget from asking
    // an arbitrary third-party host for bytes.
    const url = 'https://cdn.example.com/a.jpg';
    const { container } = render(NoteContent, {
      props: {
        parts: parseContent(url),
        showMedia: false,
        media: [{ kind: 'media' as const, media: 'image' as const, url }],
      },
    });

    expect(container.querySelector('img')).toBeNull();
  });

  it('falls back to a link when the image fails to load', async () => {
    const { container } = render(NoteContent, {
      props: { content: 'https://cdn.example.com/a.jpg' },
    });

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    await fireEvent.error(image as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'https://cdn.example.com/a.jpg' })).toBeInTheDocument();
  });

  it('names a mention when the author is already on the timeline', () => {
    const profiles = new Map<string, Profile>([[NPUB_HEX, { displayName: 'たけし' }]]);
    render(NoteContent, { props: { content: `hi nostr:${NPUB}`, profiles } });

    expect(screen.getByText('@たけし')).toBeInTheDocument();
  });

  it('abbreviates a mention of someone it knows nothing about', () => {
    render(NoteContent, { props: { content: `hi nostr:${NPUB}` } });

    const mention = screen.getByTitle(`nostr:${NPUB}`);
    expect(mention).toHaveTextContent('npub10elf…jptg');
  });

  it('does not turn a mention into a link', () => {
    // The widget has no client to send a reader to, so a mention is decoration.
    const { container } = render(NoteContent, { props: { content: `nostr:${NPUB}` } });

    expect(container.querySelector('a')).toBeNull();
  });

  describe('mention press', () => {
    const AUTHOR = { id: 'open-profile', label: 'プロフィールを開く' };
    /** An event reference, which is not a person. */
    const NOTE = 'note1tszzj2cssqzj6kfufd05umeu5rswpedhdedn6rsde49ukxm20ugsx4elrl';

    it('leaves a mention plain until an embedder asks for the press', () => {
      const { container } = render(NoteContent, {
        props: { content: `hi nostr:${NPUB}`, onAuthorPress: vi.fn() },
      });

      expect(container.querySelector('button')).toBeNull();
    });

    it('names the press and who it is on', () => {
      const profiles = new Map<string, Profile>([[NPUB_HEX, { displayName: 'たけし' }]]);
      render(NoteContent, {
        props: {
          content: `hi nostr:${NPUB}`,
          profiles,
          authorAction: AUTHOR,
          onAuthorPress: vi.fn(),
        },
      });

      expect(screen.getByRole('button', { name: 'プロフィールを開く: @たけし' })).toHaveTextContent(
        '@たけし'
      );
    });

    it('reports the mentioned pubkey, not the one written in the body', async () => {
      const onAuthorPress = vi.fn();
      render(NoteContent, {
        props: { content: `hi nostr:${NPUB}`, authorAction: AUTHOR, onAuthorPress },
      });

      await fireEvent.click(screen.getByRole('button'));

      expect(onAuthorPress).toHaveBeenCalledWith(NPUB_HEX);
    });

    it('presses someone it has no name for, as the abbreviated npub it shows', () => {
      render(NoteContent, {
        props: { content: `hi nostr:${NPUB}`, authorAction: AUTHOR, onAuthorPress: vi.fn() },
      });

      expect(
        screen.getByRole('button', { name: 'プロフィールを開く: npub10elf…jptg' })
      ).toBeInTheDocument();
    });

    it('leaves a reference to an event alone: it is not a person', () => {
      const { container } = render(NoteContent, {
        props: { content: `see nostr:${NOTE}`, authorAction: AUTHOR, onAuthorPress: vi.fn() },
      });

      expect(container.querySelector('button')).toBeNull();
      expect(screen.getByTitle(`nostr:${NOTE}`)).toHaveTextContent('note1tszz…elrl');
    });
  });

  it('renders no paragraph for a note that is only an attachment', () => {
    const { container } = render(NoteContent, {
      props: { content: 'https://cdn.example.com/a.jpg' },
    });

    expect(container.querySelector('.content')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });
});
