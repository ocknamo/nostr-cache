<script lang="ts">
  import type { Profile } from '../lib/profile.ts';

  interface Props {
    pubkey: string;
    /** The author's profile, once kind 0 has arrived. */
    profile?: Profile;
    /** Accessible name for the image, normally the author's display name. */
    name: string;
  }

  const { pubkey, profile, name }: Props = $props();

  /**
   * Set when the avatar URL fails to load, so a broken image falls back to the
   * generated block rather than leaving a gap in the row.
   *
   * Keyed by URL: without this, switching from a broken picture to a working
   * one (a profile update) would stay stuck on the fallback.
   */
  let failedUrl = $state<string | undefined>();

  const picture = $derived(profile?.picture);
  const showImage = $derived(Boolean(picture) && picture !== failedUrl);

  /**
   * A stable colour per author, so the same pubkey always gets the same block.
   * Two hex digits give 256 hues, which is plenty to tell adjacent cards apart.
   */
  const hue = $derived(Number.parseInt(pubkey.slice(0, 2), 16) || 0);
  const initials = $derived(pubkey.slice(0, 2).toUpperCase());
</script>

{#if showImage}
  <img
    class="avatar"
    part="avatar"
    src={picture}
    alt={name}
    width="40"
    height="40"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    onerror={() => {
      failedUrl = picture;
    }}
  />
{:else}
  <!-- aria-hidden: the two hex digits are decorative, and the author's name is
       already in the header right next to this. -->
  <span class="avatar fallback" part="avatar" style="--nt-avatar-hue: {hue}" aria-hidden="true">
    {initials}
  </span>
{/if}

<style>
  .avatar {
    display: block;
    width: var(--nt-avatar-size, 40px);
    height: var(--nt-avatar-size, 40px);
    border-radius: var(--nt-avatar-radius, 8px);
    /* The card's grid gives the column a fixed width; without this an image
       with a non-square intrinsic size would letterbox inside it. */
    object-fit: cover;
    background: var(--nt-avatar-bg, #e8eef5);
  }

  .fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Derived from the pubkey so an author is recognisable before — or without —
       their profile. Kept light enough for white text at any hue. */
    background: hsl(var(--nt-avatar-hue, 210) 45% 55%);
    color: #fff;
    font-size: calc(var(--nt-avatar-size, 40px) * 0.34);
    font-weight: 700;
    letter-spacing: 0.02em;
    user-select: none;
  }
</style>
