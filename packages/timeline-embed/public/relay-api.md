# Using the nostr-cache relay from the hosted script

A page-local Nostr relay that runs in the browser, stores events in IndexedDB, and optionally proxies one or more upstream relays. Your Nostr client connects to it with a normal `WebSocket` at `ws://nostr-cache.invalid` and gets responses from the cache, with upstream relays filling it in. No build step or npm package is needed.

## Minimal setup

```html
<script src="https://ocknamo.github.io/nostr-cache/nostr-timeline.js"></script>
<script>
  (async () => {
    const { acquireRelayHost } = globalThis.NostrTimelineEmbed;
    const host = await acquireRelayHost({ upstreamRelays: ['wss://nos.lol'] });

    const ws = new WebSocket(host.interceptUrl); // 'ws://nostr-cache.invalid'
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [1], limit: 20 }]));
    ws.onmessage = (e) => {
      const [type, subId, event] = JSON.parse(e.data);
      if (type === 'EVENT') console.log(event.content); // may keep arriving after EOSE
    };
  })();
</script>
```

Rules that this example depends on:

1. **Load the script once per page.** It calls `customElements.define()` when it loads, so a second copy throws. If the page already loads it for a widget, use that copy.
2. **Connect after `await acquireRelayHost()` resolves.** The relay replaces `globalThis.WebSocket` when it finishes starting. Sockets created earlier, or by a library that saved the `WebSocket` constructor earlier, bypass the cache. For example, nostr-tools' `SimplePool` saves it when the module loads, so call its `useWebSocketImplementation(WebSocket)` after the await.
3. **Only `host.interceptUrl` is intercepted.** Connections to any other URL go to the network unchanged.

## `acquireRelayHost(config?)`

Starts the page's relay, or joins it if one is already running. Returns `Promise<RelayHost>`. Every key is optional.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `upstreamRelays` | `string[]` | `[]` | Real relays to read through and write through. With `[]`, the relay serves only cached events. |
| `dbName` | `string` | `'nostr-cache-embed'` | IndexedDB database name. |
| `storageMaxSize` | `number` | `5000` | Maximum number of stored events. A periodic sweep trims the store to about 90% of this. `0` or less means no limit. |
| `cacheStrategy` | `'LRU' \| 'FIFO' \| 'LFU'` | `'LRU'` | Which events are evicted first. Kinds 0, 3 and 10002 are always evicted last. |
| `profileFreshness` | `number` (seconds) | `86400` | A kind 0 that was cached less than this many seconds ago is served from the cache without asking upstream. `0` turns this off. |
| `followsFreshness` | `number` (seconds) | `3600` | The same setting for kind 3. |
| `indexRelays` | `string[]` | `['wss://purplepag.es', 'wss://indexer.coracle.social', 'wss://directory.yabu.me']` | Relays used to look up authors' kind 10002 relay lists (NIP-65 outbox model). `[]` turns the outbox model off. It is always off when `upstreamRelays` is empty. |
| `interceptUrl` | `string` | `'ws://nostr-cache.invalid'` | The URL that is served by the relay. |
| `lazyValidateInterval` | `number` (seconds) | `5` | How often signatures are checked in the background. |

The constants `DEFAULT_INTERCEPT_URL`, `DEFAULT_DB_NAME`, `DEFAULT_STORAGE_MAX_SIZE`, `DEFAULT_CACHE_STRATEGY`, `DEFAULT_PROFILE_FRESHNESS`, `DEFAULT_FOLLOWS_FRESHNESS` and `DEFAULT_LAZY_VALIDATE_INTERVAL` are also on `NostrTimelineEmbed`.

**A page has only one relay, and the first caller's config is used.** A later call with a different config joins the running relay, ignores the differing keys and logs a console warning. If the page also has `<nostr-timeline>` elements, give them the same settings (`relays`, `db-name`, `max-events`, `profile-freshness`, `follows-freshness`, `index-relays`).

`acquireRelayHost()` rejects if the relay cannot start, for example when IndexedDB is unavailable. In that case, connect the client to the real relays directly.

## The returned handle

Use only these members. The others (`relay`, `storage`, `metrics`) are internal and may change without notice.

| Member | Meaning |
|---|---|
| `interceptUrl` | The URL to pass to `new WebSocket()`. |
| `getConnectedUpstreams(): number` | How many of `upstreamRelays` are connected right now. |
| `clearCache(): Promise<void>` | Deletes every stored event. The relay keeps running and open subscriptions stay open, so events already on screen remain; reload the page to see an empty cache. Throws if the handle is already released. |
| `release(): Promise<void>` | Gives back this acquisition. When the last one is released, the relay stops and `globalThis.WebSocket` is restored once the promise resolves. Calling it again does nothing. |

Call `release()` exactly once for every `acquireRelayHost()`. As long as the app holds one acquisition, the relay keeps running while widgets are added and removed. `NostrTimelineEmbed.getRelayHostRefCount()` returns the number of acquisitions not yet released.

## Protocol

Use NIP-01 over the WebSocket.

- Client to relay: `["REQ", subId, ...filters]`, `["EVENT", event]`, `["CLOSE", subId]`
- Relay to client: `["EVENT", subId, event]`, `["EOSE", subId]`, `["OK", eventId, accepted, message]`, `["CLOSED", subId, message]`, `["NOTICE", message]`

The relay also follows NIP-02 (kind 3 is replaceable), NIP-09 (kind 5 deletions are applied) and NIP-65 (outbox model, see below). NIP-42 AUTH to upstream relays is not supported, so relays that require AUTH cannot be used as upstreams.

## Cache behaviour

- **Read-through:** a REQ returns matching stored events first, and is also forwarded to the upstream relays. New events from upstream are stored and sent to the client. The upstream subscription stays open until CLOSE, so live events keep arriving after EOSE.
- **EOSE does not mean upstream is done.** EOSE waits (up to 3 seconds) only for the upstreams that were connected when the REQ arrived. `acquireRelayHost()` resolves before upstreams connect, so a REQ sent right after it usually gets EOSE with cached events only, and upstream's older events arrive after EOSE. For a one-shot fetch, keep reading after EOSE, or wait until `host.getConnectedUpstreams() > 0` before sending the REQ.
- **EOSE can come more than once.** When an upstream relay connects or reconnects while a subscription is open, the REQ is sent to it again, and the end of its answer is sent as another EOSE on the same subscription. A client connected straight to that relay would see the same thing after reconnecting.
- **Skipping upstream:** each filter that the cache already answers is not sent upstream: a filter whose `ids` were all returned, or a `kinds` + `authors` filter for kind 0 / 3 (and 10002 when the outbox model is on) cached within its freshness window. If no filter is left, EOSE comes at once. Skipped filters get no live updates from upstream.
- **Write-through:** a published EVENT is stored locally and then sent to the upstream relays that are connected at that moment, without waiting for them. Relays that are disconnected at that moment never get it, and nothing is retried. An older version of a replaceable event also gets `OK true`, although it is neither stored nor sent. `OK true` therefore does not mean the event reached any upstream.
- **Outbox model (on by default when `upstreamRelays` is set):** the relay also reads from authors' write relays and from mentioned users' read relays, and sends published events to them. The browser therefore connects to relays not listed in `upstreamRelays`. Set `indexRelays: []` to prevent this.
- **Signatures** are checked in the background (every `lazyValidateInterval` seconds), and events that fail are deleted. Until then, an event with a bad signature gets `OK true` and is delivered and forwarded upstream, so a successful publish does not prove the event is valid. Kinds 5, 10002 and ephemeral events are checked before they are accepted.
- **Errors** such as an invalid filter, or a REQ beyond the limit of 20 open subscriptions per socket, are answered with `NOTICE` only, with no EOSE or CLOSED. A REQ returns at most 500 cached events. The relay answers `CLOSE` with `CLOSED`.

## Other constraints

- An `https://` page cannot use `ws://` upstream relays (the browser blocks mixed content). Use `wss://`.
- The script includes the widgets even if only the relay is used.
- The script URL always serves the latest build. Pin a copy yourself if the user needs a fixed version.
- Events are stored in the IndexedDB of the embedding page's origin, so they count toward that origin's storage quota.
