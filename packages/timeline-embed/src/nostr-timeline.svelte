<svelte:options
  customElement={{
    tag: 'nostr-timeline',
    props: {
      relays: { attribute: 'relays' },
      kinds: { attribute: 'kinds' },
      authors: { attribute: 'authors' },
      limit: { attribute: 'limit' },
      dbName: { attribute: 'db-name' },
      showOrigin: { attribute: 'show-origin' },
    },
  }}
/>

<script lang="ts">
  import Timeline from './components/Timeline.svelte';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import { parseFilter, parseRelays } from './lib/timeline-config.ts';

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
    /** Set to "false" to hide the cache/upstream badges. */
    showOrigin?: string;
  }

  const { relays, kinds, authors, limit, dbName, showOrigin }: Props = $props();

  let state = $state<TimelineState>({
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    eose: false,
  });

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. That is safe even when this is the only widget on the
  // page — `acquireRelayHost` waits for a host that is still shutting down
  // before starting its replacement — but it does restart the relay, so prefer
  // setting the attributes before the element is connected.
  $effect(() => {
    const controller = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
      },
      onChange: (next) => {
        state = next;
      },
    });

    void controller.start(parseFilter({ kinds, authors, limit }));

    return () => {
      void controller.stop();
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
    showOrigin={showOrigin !== 'false'}
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
