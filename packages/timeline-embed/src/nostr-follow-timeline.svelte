<svelte:options
  customElement={{
    tag: 'nostr-follow-timeline',
    props: {
      pubkey: { attribute: 'pubkey' },
      relays: { attribute: 'relays' },
      kinds: { attribute: 'kinds' },
      limit: { attribute: 'limit' },
      maxFollows: { attribute: 'max-follows' },
      includeSelf: { attribute: 'include-self' },
      sinceDays: { attribute: 'since-days' },
      followsFreshness: { attribute: 'follows-freshness' },
      dbName: { attribute: 'db-name' },
      profileFreshness: { attribute: 'profile-freshness' },
      debug: { attribute: 'debug' },
      showAvatars: { attribute: 'show-avatars' },
      showMedia: { attribute: 'show-media' },
    },
  }}
/>

<script lang="ts">
  /**
   * `<nostr-follow-timeline pubkey="npub1…">` — the home timeline of whoever
   * `pubkey` names: the posts of everyone they follow, per their NIP-02 kind 3.
   *
   * A separate element rather than an attribute on `<nostr-timeline>`. That one
   * already has `filters` and `authors`, and a third way to name authors would
   * need a precedence rule between all three — with the failure mode that
   * someone writes `filters` and has it silently ignored. Splitting them makes
   * `pubkey` required by construction and leaves nothing to disambiguate.
   *
   * Everything below the filter is shared: `TimelineView` renders the same
   * chrome and the same `Timeline` as `<nostr-timeline>`, and both elements run
   * the same `TimelineController` against the same page-wide relay.
   */

  import TimelineView from './components/TimelineView.svelte';
  import { DEFAULT_MAX_FOLLOWS, followFilterSource } from './lib/follow-list.ts';
  import { TimelineController, type TimelineState } from './lib/timeline-controller.ts';
  import {
    parseDebug,
    parseEnabled,
    parseFreshness,
    parseKinds,
    parseLimit,
    parseMaxFollows,
    parsePubkey,
    parseRelays,
    parseSinceDays,
  } from './lib/timeline-config.ts';

  interface Props {
    /**
     * Whose follow list to walk. hex, `npub` or `nprofile`.
     *
     * The one attribute with no usable default: without it there is no follow
     * list, and there is no wider query to fall back to that would not mean
     * asking the upstream relays for the global feed.
     */
    pubkey?: string;
    /** Comma-separated upstream relay URLs. Empty = cache-only. */
    relays?: string;
    /**
     * Comma-separated event kinds for the timeline. Defaults to `1`.
     *
     * Adding `6` (reposts) renders badly: `EventCard` does not interpret them,
     * so a repost arrives as an empty card or raw JSON. See the README.
     */
    kinds?: string;
    /** Max events to request. Defaults to 50. */
    limit?: string;
    /**
     * Cap on how many follow-list entries reach the timeline filter.
     *
     * A safety valve for pathological lists, not a tuning knob — the default is
     * set above any realistic follow list. See `follow-list.ts`.
     */
    maxFollows?: string;
    /** Set to "false" to leave the subject's own posts out. */
    includeSelf?: string | boolean;
    /**
     * Only show posts from the last N days.
     *
     * Off by default. It bounds the local query, but a quiet follow list then
     * renders as an empty timeline with no way for the reader to tell that from
     * "nobody posted".
     */
    sinceDays?: string;
    /**
     * Seconds a cached follow list (kind 3) is used before the relay re-asks
     * upstream. Defaults to ten minutes; `0` re-asks on every load.
     */
    followsFreshness?: string;
    /** IndexedDB database name for the shared cache. */
    dbName?: string;
    /**
     * Seconds a cached profile (kind 0) is shown before the relay re-asks
     * upstream. Defaults to a day; `0` re-asks on every lookup.
     */
    profileFreshness?: string;
    /**
     * Set (`debug` / `debug="true"`) to render the diagnostic cache/upstream
     * badges and the follow-truncation notice.
     */
    debug?: string | boolean;
    /** Set to "false" to hide author avatars. */
    showAvatars?: string;
    /** Set to "false" to stop rendering media found in a note's body. */
    showMedia?: string;
  }

  const {
    pubkey,
    relays,
    kinds,
    limit,
    maxFollows,
    includeSelf,
    sinceDays,
    followsFreshness,
    dbName,
    profileFreshness,
    debug,
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

  // Not `$state`: nothing renders from it, the visibility callback just needs
  // whichever controller is current when a card appears.
  let controller: TimelineController | undefined;

  /**
   * The subject, or `undefined` when the attribute is unusable.
   *
   * Derived rather than reported through `state` inside the effect below: an
   * effect that writes the same state it reads re-runs itself forever.
   */
  const subject = $derived(parsePubkey(pubkey));

  // Attributes are reactive: changing one tears this widget's controller down
  // and builds a new one. Prefer setting them before the element is connected.
  $effect(() => {
    if (!subject) {
      // Every other attribute survives a typo by falling back to a default.
      // This one cannot, so nothing is started at all — rather than quietly
      // showing someone else's timeline, or, far worse, everyone's.
      return;
    }

    const active = new TimelineController({
      host: {
        upstreamRelays: parseRelays(relays),
        dbName: dbName || undefined,
        // Left undefined when unset so the host keeps its own default rather
        // than this widget pinning one — which also keeps two widgets that both
        // omit the attribute from looking like conflicting configurations.
        profileFreshness: parseFreshness(profileFreshness),
        followsFreshness: parseFreshness(followsFreshness),
      },
      onChange: (next) => {
        state = next;
      },
    });

    controller = active;
    void active.start(
      followFilterSource({
        pubkey: subject,
        kinds: parseKinds(kinds),
        limit: parseLimit(limit),
        maxFollows: parseMaxFollows(maxFollows) ?? DEFAULT_MAX_FOLLOWS,
        includeSelf: parseEnabled(includeSelf),
        sinceSeconds: parseSinceDays(sinceDays),
      })
    );

    return () => {
      controller = undefined;
      void active.stop();
    };
  });
</script>

<TimelineView
  {state}
  fatal={subject ? undefined : 'pubkey が不正です（hex / npub / nprofile を指定してください）'}
  showOrigin={parseDebug(debug)}
  debug={parseDebug(debug)}
  showAvatars={showAvatars !== 'false'}
  showMedia={showMedia !== 'false'}
  onAuthorVisible={(key) => controller?.requestProfile(key)}
/>
