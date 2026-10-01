import { startFeedCache } from './service.js';
import { snapshotResponse } from './cache.js';
const cache = await startFeedCache();
const server = Bun.serve({
  hostname: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8792),
  fetch(req) {
    if (new URL(req.url).pathname !== '/api/feed') return new Response('Not found', { status: 404 });
    return snapshotResponse(cache, req);
  },
});
console.log(`Public feed cache listening on ${server.url}`);
