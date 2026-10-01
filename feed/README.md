# Shared public feed cache

The default Popular feed fetches `/api/feed` before querying Nostr relays.
The service collects the same popular-post candidates as the browser, with
signed author profiles. Language, replies, spam and mute filtering remain in
the client. Custom relay selections and pagination use the existing relay path.
The client verifies signatures from the HTTP snapshot too.

Run from the repository with dependencies installed:

```sh
bun run feed:serve
```

The service binds to `127.0.0.1:8792` by default (`HOST` and `PORT` override).
Run it under your existing process supervisor, then add a same-origin proxy
alongside the static site's routes. For nginx:

```nginx
location = /api/feed {
    proxy_pass http://127.0.0.1:8792;
}
```

Rebuild and deploy the frontend with `bun run build`. `bun run dev` includes
the cache endpoint automatically. Static or standalone installations without
the endpoint fall back to relays; no separate cache host is hardcoded.

One background job queries a fixed set of four public relays, with a one-minute
snapshot lifetime. Visitors receive the previous snapshot during refreshes.
Concurrent requests cannot launch duplicate jobs. Failed/empty refreshes retain
the previous result and retry after at least 15 seconds. A snapshot older than
24 hours is not served. Cold starts without a saved snapshot return 503 promptly
so browsers can fall back while the service warms.

The latest snapshot is atomically saved to `db/public-feed.json`; set
`FEED_CACHE_FILE` to change the path. Give the service user write access to its
parent directory. The snapshot holds only public posts/profiles, at most 240 of
each, with individual events capped at 32 KB. It is shared across languages and
users; the server accepts no user-selected relays or personalized query inputs.
Browsers cache HTTP responses for 15 seconds; the service worker bypasses this
endpoint so it cannot freeze an old feed indefinitely.

This removes repeated initial reaction scans and profile discovery. Images,
link previews, quoted posts, live updates and older pages can still require
client requests. A language with no usable cached posts falls back to relays.

Validation: `bun tools/public-feed-cache-test.js`.

## Current production deployment

`v3.coinos.io` is served by the `bitcoin-wallet` nginx container on SSH host
`cs`. The `public-feed` container runs the bundled `feed/server.js` on the
existing Docker `net` network, with `unless-stopped` restart policy. No host
port is published. Its bundle is `/home/adam/public-feed/server.js`, and its
persistent snapshot is `/home/adam/public-feed/data/public-feed.json`.
The nginx config is `/home/adam/bitcoin-wallet-nginx.conf`; `/api/feed` proxies
to `public-feed:8792` using Docker DNS with periodic resolution.

To update the service, bundle with
`bun build feed/server.js --target=bun --minify --outfile=/tmp/coinos-public-feed-server.js`,
copy that file over the existing remote bundle, then `ssh cs 'docker restart public-feed'`.
The frontend is built locally and copied to `cs:bitcoin-wallet/`, retaining
older hashed assets for existing browser sessions. Publish assets before
`index.html` and `sw.js`. Pre-cache-deployment nginx, HTML and service-worker
backups are in `/home/adam/public-feed/backups/` on `cs`.
