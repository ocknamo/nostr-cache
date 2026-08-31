<svelte:options
  customElement={{
    tag: 'nostr-timeline',
    props: {
      relays: { attribute: 'relays' },
      filters: { attribute: 'filters' },
      kinds: { attribute: 'kinds' },
      authors: { attribute: 'authors' },
      limit: { attribute: 'limit' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      followsFreshness: { attribute: 'follows-freshness' },
      maxEvents: { attribute: 'max-events' },
      infiniteScroll: { attribute: 'infinite-scroll' },
      maxTimelineEvents: { attribute: 'max-timeline-events' },
      debug: { attribute: 'debug' },
      showOrigin: { attribute: 'show-origin' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
      showEmbeds: { attribute: 'show-embeds' },
      ogpProxy: { attribute: 'ogp-proxy' },
      actions: { attribute: 'actions' },
      authorAction: { attribute: 'author-action' },
      authorActionLabel: { attribute: 'author-action-label' },
      noteAction: { attribute: 'note-action' },
      noteActionLabel: { attribute: 'note-action-label' },
      materialIcons: { attribute: 'material-icons' },
      materialIconsFont: { attribute: 'material-icons-font' },
    },
  }}
/>

<script lang="ts">
  import TimelineView from './components/TimelineView.svelte';
  import {
    type SharedEmbedProps,
    ensureIconFont,
    relayConfigFrom,
    viewPropsFrom,
  } from './lib/embed-props.ts';
  import { dispatchActionEvent } from './lib/event-actions.ts';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseEnabled,
    parseFilters,
    parseMaxTimelineEvents,
    parseShowOriginAlias,
  } from './lib/timeline-config.ts';

  interface Props extends SharedEmbedProps {
    /**
     * JSON array of NIP-01 filters, e.g.
     * `'[{"kinds":[1],"limit":10},{"kinds":[6],"limit":5}]'`.
     *
     * They travel as a single REQ, so events matching any of them share one
     * timeline. Reaches the fields `kinds` / `authors` / `limit` cannot
     * (`since`, `until`, `ids`, tag filters), and takes precedence over all
     * three when it parses to at least one usable filter.
     */
    filters?: string;
    /** Comma-separated event kinds. Ignored when `filters` is set. Defaults to `1,6`. */
    kinds?: string;
    /** Comma-separated author pubkeys (hex). Ignored when `filters` is set. */
    authors?: string;
    /** Max events to request. Ignored when `filters` is set. Defaults to 50. */
    limit?: string;
    /**
     * Deprecated spelling of `debug`, kept for embeds written before the badges
     * became opt-in. `show-origin="true"` still shows them; an absent attribute
     * no longer does.
     */
    showOrigin?: string | boolean;
    /**
     * Set to `"false"` to stop the timeline loading older events as the reader
     * reaches the end. On by default; it costs the relay one read-through per
     * page, and a page under a `since` / `until` filter always reaches upstream.
     */
    infiniteScroll?: string | boolean;
    /**
     * Events kept on screen — and so how far the infinite scroll can go back.
     * `0` lifts the ceiling. **Not** `max-events`, which bounds the cache.
     */
    maxTimelineEvents?: string;
  }

  const {
    filters,
    kinds,
    authors,
    limit,
    showOrigin,
    infiniteScroll,
    maxTimelineEvents,
    ...shared
  }: Props = $props();

  const paging = $derived(parseEnabled(infiniteScroll));

  const view = $derived(viewPropsFrom(shared));

  // The element itself, so a press can be announced to the embedding page —
  // which, having written HTML rather than JS, has no callback to receive.
  const hostElement = $host();

  $effect(() => {
    ensureIconFont(view.materialIcons, shared.materialIconsFont);
  });

  let state = $state<TimelineState>({
    status: 'disconnected',
    events: [],
    origins: new Map(),
    validationStatuses: new Map(),
    profiles: new Map(),
    embeds: new Map(),
    reactions: new Map(),
    replies: new Map(),
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
      host: relayConfigFrom(shared),
      maxEvents: parseMaxTimelineEvents(maxTimelineEvents),
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start(parseFilters({ filters, kinds, authors, limit }));

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<TimelineView
  {state}
  showOrigin={parseDebug(shared.debug) || parseShowOriginAlias(showOrigin)}
  debug={parseDebug(shared.debug)}
  {...view}
  onAction={(action, context) => dispatchActionEvent(hostElement, action, context)}
  onAuthorVisible={(pubkey) => controller?.requestProfile(pubkey)}
  onEmbedRequest={(target) => controller?.requestEmbed(target)}
  onReachEnd={paging ? () => void controller?.loadOlder() : undefined}
/>
