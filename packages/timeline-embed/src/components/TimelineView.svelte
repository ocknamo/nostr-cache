<script lang="ts">
  /**
   * The chrome both custom elements render around `Timeline`.
   *
   * `<nostr-timeline>` and `<nostr-follow-timeline>` differ only in how their
   * subscription filters are decided; everything downstream of that — the error
   * banner, the reconnect notice, the follow-resolution notices and the widget's
   * own styling — is identical, so it lives here rather than being written twice.
   * Svelte's custom elements still declare their props separately (that part
   * cannot be shared), which is the whole of the duplication between them.
   *
   * The follow notices sit here rather than in `Timeline.svelte` on purpose:
   * they belong with the error and reconnect banners, which are also about the
   * widget's state rather than about events, and it keeps `Timeline` doing one
   * thing.
   */

  import type { TimelineState } from '../lib/timeline-controller.ts';
  import Timeline from './Timeline.svelte';

  interface Props {
    /** Latest snapshot from the controller. */
    state: TimelineState;
    /** Render the diagnostic cache/upstream badges. */
    showOrigin?: boolean;
    /** Render author avatars. */
    showAvatars?: boolean;
    /** Render media attachments found in a note's body. */
    showMedia?: boolean;
    /**
     * Whether the widget is in diagnostic mode. Separate from `showOrigin`
     * because the deprecated `show-origin` alias turns the badges on without
     * asking for the rest of the diagnostics.
     */
    debug?: boolean;
    /**
     * A configuration error that stops the widget before it starts.
     *
     * Rendered *instead of* everything else, unlike `state.error`, which
     * reports a relay that failed while a timeline was already running. Nothing
     * below it would have anything to show.
     */
    fatal?: string;
    /** Called when an author's card scrolls into view. */
    onAuthorVisible?: (pubkey: string) => void;
  }

  const {
    state,
    showOrigin = false,
    showAvatars = true,
    showMedia = true,
    debug = false,
    fatal,
    onAuthorVisible,
  }: Props = $props();

  const follows = $derived(state.follows);

  /**
   * Whether there is a timeline to render at all.
   *
   * `missing` means no subscription was ever opened (there was no follow list
   * to build one from), so `Timeline` would sit on "読み込み中…" forever waiting
   * for an EOSE that cannot come. `invalid` means the list the authors came from
   * was forged and deleted, so what the subscription produced is the wrong
   * population — the notice replaces it rather than sitting above it.
   */
  const collapsed = $derived(follows?.status === 'missing' || follows?.status === 'invalid');

  const followNotice = $derived.by(() => {
    switch (follows?.status) {
      case 'resolving':
        return 'フォローリストを取得しています…';
      case 'missing':
        return 'フォローリストが見つかりませんでした';
      case 'invalid':
        return 'フォローリストの署名検証に失敗しました';
      default:
        return undefined;
    }
  });
</script>

<div class="widget" part="widget">
  {#if fatal}
    <p class="error" part="error">{fatal}</p>
  {:else}
    {#if state.error}
      <p class="error" part="error">{state.error}</p>
    {/if}
    <!--
      Shown rather than swapped in for the timeline: rx-nostr keeps retrying and
      re-issues the subscriptions when it gets back, so the events already on
      screen stay readable and simply resume updating.
    -->
    {#if state.status === 'reconnecting'}
      <p class="reconnecting" part="reconnecting">リレーに再接続しています…</p>
    {/if}
    {#if followNotice}
      <p class="follows" class:follows-error={collapsed} part="follows">{followNotice}</p>
    {/if}
    <!--
      Only under `debug`: an embedder wants to know their cap dropped part of the
      follow list, but a reader of the embedding page has no use for the number
      and no way to act on it.
    -->
    {#if debug && follows?.status === 'ready' && follows.truncated > 0}
      <p class="follows" part="follows">
        {follows.count + follows.truncated} 人中 {follows.count} 人を表示しています
      </p>
    {/if}
    {#if !collapsed}
      <Timeline
        events={state.events}
        eose={state.eose}
        origins={state.origins}
        validationStatuses={state.validationStatuses}
        profiles={state.profiles}
        {showOrigin}
        {showAvatars}
        {showMedia}
        {onAuthorVisible}
      />
    {/if}
  {/if}
</div>

<style>
  .widget {
    display: block;
    font-family: var(
      --nt-font,
      system-ui,
      -apple-system,
      'Segoe UI',
      'Helvetica Neue',
      sans-serif
    );
    font-size: var(--nt-font-size, 14px);
    background: var(--nt-bg, transparent);
    color: var(--nt-fg, #0f1419);
  }

  .error {
    margin: 0 0 10px;
    padding: 8px 12px;
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-error-bg, #fdecea);
    color: var(--nt-error-fg, #a4262c);
    font-size: 0.85rem;
  }

  .reconnecting {
    margin: 0 0 10px;
    padding: 8px 12px;
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-notice-bg, #fff4e5);
    color: var(--nt-notice-fg, #8a5300);
    font-size: 0.85rem;
  }

  .follows {
    margin: 0 0 10px;
    padding: 8px 12px;
    border-radius: var(--nt-radius, 10px);
    background: var(--nt-notice-bg, #fff4e5);
    color: var(--nt-notice-fg, #8a5300);
    font-size: 0.85rem;
  }

  .follows-error {
    background: var(--nt-error-bg, #fdecea);
    color: var(--nt-error-fg, #a4262c);
  }
</style>
