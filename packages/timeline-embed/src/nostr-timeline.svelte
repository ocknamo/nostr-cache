<svelte:options
  customElement={{
    tag: 'nostr-timeline',
    props: {
      relays: { attribute: 'relays' },
      kinds: { attribute: 'kinds' },
      authors: { attribute: 'authors' },
      limit: { attribute: 'limit' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      debug: { attribute: 'debug' },
      showOrigin: { attribute: 'show-origin' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
    },
  }}
/>

<script lang="ts">
  import Timeline from './components/Timeline.svelte';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseFilter,
    parseFreshness,
    parseRelays,
    parseShowOriginAlias,
  } from './lib/timeline-config.ts';

  interface Props {
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    /** Comma-separated event kinds. Defaults to `1`. */
    kinds?: string;
    /** Comma-separated author pubkeys (hex). */
    authors?: string;
    /** Max events to request. Defaults to 50. */
    limit?: string;
    /** IndexedDB database name for the shared cache. */
    dbName?: string;
    /**
     * Seconds a cached profile (kind 0) is shown before the relay re-asks
     * upstream. Defaults to a day; `0` re-asks on every lookup.
     */
    profileFreshness?: string;
    /**
     * Set (`debug` / `debug="true"`) to render the diagnostic cache/upstream
     * badges. Off by default — they are for checking that the cache works, not
     * for the readers of the embedding page.
     *
     * Typed as a boolean too because a Svelte parent's bare `debug` sets the
     * property rather than the attribute.
     */
    debug?: string | boolean;
    /**
     * Deprecated spelling of `debug`, kept for embeds written before the badges
     * became opt-in. `show-origin="true"` still shows them; an absent attribute
     * no longer does.
     */
    showOrigin?: string | boolean;
    /**
     * Set to "false" to hide author avatars. Names are still fetched; this only
     * stops the widget from loading images from whatever host a profile names.
     */
    showAvatars?: string;
    /**
     * Set to "false" to stop rendering images, video and audio found in a
     * note's body. The URLs stay in the text as links, so nothing is hidden —
     * this only stops the widget from fetching from whatever host a note names.
     */
    showMedia?: string;
  }

  const {
    relays,
    kinds,
    authors,
    limit,
    dbName,
    profileFreshness,
    debug,
    showOrigin,
    showAvatars,
    showMedia,
  }: Props = $props();

  let state = $state<TimelineState>({
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    eose: false,
  });

  // Deliberately not `$state`: nothing renders from it, the visibility callback
  // just needs whichever controller is current when a card appears. (It also
  // cannot be named alongside `$state` here — Svelte reads `$state` as a store
  // subscription to the `state` variable above.)
  let controller: TimelineController | undefined;

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. That is safe even when this is the only widget on the
  // page — `acquireRelayHost` waits for a host that is still shutting down
  // before starting its replacement — but it does restart the relay, so prefer
  // setting the attributes before the element is connected.
  $effect(() => {
    const active = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
        // Left undefined when unset so the host keeps its own default rather
        // than this widget pinning one — which also keeps two widgets that both
        // omit the attribute from looking like conflicting configurations.
        profileFreshness: parseFreshness(profileFreshness),
      },
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start(parseFilter({ kinds, authors, limit }));

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<div class="widget" part="widget">
  {#if state.error}
    <p class="error" part="error">{state.error}</p>
  {/if}
  <Timeline
    events={state.events}
    eose={state.eose}
    origins={state.origins}
    validationStatuses={state.validationStatuses}
    profiles={state.profiles}
    showOrigin={parseDebug(debug) || parseShowOriginAlias(showOrigin)}
    showAvatars={showAvatars !== 'false'}
    showMedia={showMedia !== 'false'}
    onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
  />
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
</style>
