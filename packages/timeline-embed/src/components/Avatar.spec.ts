// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Avatar from './Avatar.svelte';

const PUBKEY = 'ff0000000000000000000000000000000000000000000000000000000000000a';

describe('Avatar', () => {
  it('renders the profile picture when there is one', () => {
    render(Avatar, {
      props: { pubkey: PUBKEY, name: 'alice', profile: { picture: 'https://example.com/a.png' } },
    });

    expect(screen.getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://example.com/a.png'
    );
  });

  it('falls back to a generated block when the profile has no picture', () => {
    const { container } = render(Avatar, { props: { pubkey: PUBKEY, name: 'alice' } });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const fallback = container.querySelector('.fallback');
    expect(fallback).toHaveTextContent('FF');
    // Same pubkey, same colour — an author stays recognisable without a profile.
    expect(fallback?.getAttribute('style')).toContain('--nt-avatar-hue: 255');
  });

  it('falls back to the generated block when the image fails to load', async () => {
    const { container } = render(Avatar, {
      props: { pubkey: PUBKEY, name: 'alice', profile: { picture: 'https://example.com/a.png' } },
    });

    const image = screen.getByRole('img', { name: 'alice' });
    image.dispatchEvent(new Event('error'));
    // A broken avatar host must not leave a hole in the row.
    await expect.poll(() => container.querySelector('.fallback')).toBeTruthy();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('asks the image proxy for an avatar-sized picture', () => {
    render(Avatar, {
      props: {
        pubkey: PUBKEY,
        name: 'alice',
        profile: { picture: 'https://example.com/a.png' },
        imageProxy: 'https://optimizer.example/image',
      },
    });

    expect(screen.getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://optimizer.example/image/width=96,quality=70,format=webp/https://example.com/a.png'
    );
  });

  it('falls back to the picture itself when the proxy cannot serve it', async () => {
    render(Avatar, {
      props: {
        pubkey: PUBKEY,
        name: 'alice',
        profile: { picture: 'https://example.com/a.png' },
        imageProxy: 'https://optimizer.example/image',
      },
    });

    // A proxy that is down must cost the reader the optimisation, not the avatar.
    screen.getByRole('img', { name: 'alice' }).dispatchEvent(new Event('error'));

    await expect
      .poll(() => screen.queryByRole('img', { name: 'alice' })?.getAttribute('src'))
      .toBe('https://example.com/a.png');
  });

  it('tries again when the profile names a different picture', async () => {
    const { container, rerender } = render(Avatar, {
      props: { pubkey: PUBKEY, name: 'alice', profile: { picture: 'https://example.com/bad.png' } },
    });
    screen.getByRole('img', { name: 'alice' }).dispatchEvent(new Event('error'));
    await expect.poll(() => container.querySelector('.fallback')).toBeTruthy();

    // The failure was recorded against the old URL, so a new one gets a chance
    // rather than inheriting the verdict.
    await rerender({ profile: { picture: 'https://example.com/good.png' } });

    await expect
      .poll(() => screen.queryByRole('img', { name: 'alice' })?.getAttribute('src'))
      .toBe('https://example.com/good.png');
  });
});
