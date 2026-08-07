<script lang="ts">
  /**
   * The chrome both custom elements render around `Timeline`.
   *
   * `<nostr-timeline>` and `<nostr-follow-timeline>` differ only in how their
   * subscription filters are decided; everything downstream of that is
   * identical, so it lives here rather than being written twice. Svelte's
   * custom elements still declare their props separately, which is the whole of
   * the remaining duplication between them.
   *
   * The follow notices sit here rather than in `Timeline.svelte` because they
   * are about the widget's state rather than about events, like the error and
   * reconnect banners beside them.
   */

  import type { TimelineState } from '../lib/timeline-controller.ts';
  import Timeline from './Timeline.svelte';

  interface Props {
    state: TimelineState;
    showOrigin?: boolean;
    showAvatars?: boolean;
    showMedia?: boolean;
    /**
     * Separate from `showOrigin` because the deprecated `show-origin` alias
     * turns the badges on without asking for the rest of the diagnostics.
     */
    debug?: boolean;
    /**
     * A configuration error that stops the widget before it starts.
     *
     * Rendered *instead of* everything else, unlike `state.error`, which
     * reports a relay that failed while a timeline was already running.
     */
    fatal?: string;
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
   * `missing` means no subscription was ever opened, so `Timeline` would sit on
   * "読み込み中…" waiting for an EOSE that cannot come. `dropped` means what the
   * subscription did produce can no longer be vouched for. Either way the
   * notice replaces the timeline rather than sitting above it.
   */
  const collapsed = $derived(follows?.status === 'missing' || follows?.status === 'dropped');

  const followNotice = $derived.by(() => {
    switch (follows?.status) {
      case 'resolving':
        return 'フォローリストを取得しています…';
      case 'missing':
        return 'フォローリストが見つかりませんでした';
      // Deliberately not "署名検証に失敗しました": the relay reports a missing
      // event the same way whether it deleted it as forged, it was removed by
      // NIP-09, or storage failed to answer. See `watchValidation`.
      case 'dropped':
        return 'フォローリストがキャッシュから失われたため、表示を中止しました';
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
      An embedder wants to know their cap dropped part of the follow list, but a
      reader of the embedding page has no use for the number, hence `debug`.
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
