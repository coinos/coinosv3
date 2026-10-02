import { SimplePool } from 'nostr-tools/pool';
import { startFeedCache } from './service.js';
import { snapshotResponse } from './cache.js';
import { NOTE_PATH, buildThread, createThreadCache, createIndexSource, notePageResponse } from './note-page.js';
const cache = await startFeedCache();
// SimplePool verifies signatures and matches filters before accepting events.
const pool = new SimplePool();
// Every relay's answer, or maxWait — but an ask by id is done the moment
// every id has turned up, rather than waiting out the slowest relay.
const query = (relays, filter, maxWait) => new Promise((resolve) => {
  const got = new Map();
  let done = false, sub = null;
  const finish = () => { if (done) return; done = true; try { sub && sub.close(); } catch {} resolve([...got.values()]); };
  sub = pool.subscribeManyEose(relays, filter, {
    maxWait,
    onevent(e) {
      got.set(e.id, e);
      if (filter.ids && filter.ids.every((id) => got.has(id))) finish();
    },
    onclose: finish,
  });
  if (done) try { sub.close(); } catch {}
});
const threads = createThreadCache({ build: (ref) => buildThread(ref, query) });
const index = createIndexSource(process.env.INDEX_URL || 'http://bitcoin-wallet/index.html');
const server = Bun.serve({
  hostname: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8792),
  idleTimeout: 30,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/api/feed') return snapshotResponse(cache, req);
    if (NOTE_PATH.test(path) && ['GET', 'HEAD'].includes(req.method)) {
      try { return await notePageResponse(req, { index, threads }); } catch { return new Response('Unavailable', { status: 502 }); }
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Public feed cache listening on ${server.url}`);
