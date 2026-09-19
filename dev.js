// Dev server: rebuilds the inlined bundle on every request so you just refresh
// the browser to see changes. Same output as `bun run build`, unminified.
//
// It also proxies the regtest backends (which bind to localhost on this machine)
// through the same origin, so the app works unchanged whether you load it on
// localhost or from a phone over the LAN/Tailscale — no per-device config, no
// CORS. HTTP backends by path prefix; WebSocket backends by exact path.

import { buildHtml, buildJsQr, buildNip46, buildVerifyWorker } from './build.js';

const port = Number(process.env.PORT || 5173);

const HTTP_PROXY = { '/boltz': 'http://localhost:9001', '/esplora': 'http://localhost:3000', '/sp': 'http://localhost:8888' };
const WS_PROXY = { '/electrum': 'ws://localhost:50003', '/sp/ws': 'ws://localhost:8888/ws' };
const JS_ASSETS = { '/jsqr.js': buildJsQr, '/nip46.js': buildNip46, '/verify-worker.js': buildVerifyWorker };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };

Bun.serve({
  port,
  hostname: '0.0.0.0', // listen on all interfaces so the LAN/Tailscale can reach it
  async fetch(req, server) {
    const NO_STORE = 'no-store, must-revalidate';
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      // WebSocket proxies (Fulcrum electrum, SP-indexer push) — upgrade + relay.
      if (WS_PROXY[path]) {
        if (server.upgrade(req, { data: { target: WS_PROXY[path] } })) return;
        return new Response('expected websocket', { status: 426 });
      }
      // HTTP proxies (boltz, esplora, SP indexer) — same-origin, CORS for cross-origin loads.
      for (const prefix in HTTP_PROXY) {
        if (path === prefix || path.startsWith(prefix + '/')) {
          if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
          const target = HTTP_PROXY[prefix] + path.slice(prefix.length) + url.search;
          const r = await fetch(target, {
            method: req.method,
            headers: req.headers.get('content-type') ? { 'content-type': req.headers.get('content-type') } : {},
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
          });
          return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json', ...CORS } });
        }
      }
      if (Object.hasOwn(JS_ASSETS, path)) {
        return new Response(await JS_ASSETS[path]({ minify: false }), {
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': NO_STORE },
        });
      }
      if (/^\/(punks|punks-sm)\//.test(path)) {
        // These are bundled images, not app routes. Returning index.html here
        // produces broken avatars and rebuilds the app for every face.
        if (!/^\/(punks|punks-sm)\/([1-9]|[1-5][0-9]|6[0-4])\.webp$/.test(path)) {
          return new Response('Not found', { status: 404 });
        }
        const file = Bun.file('static' + path);
        return await file.exists()
          ? new Response(file, { headers: { 'content-type': 'image/webp', 'cache-control': NO_STORE } })
          : new Response('Not found', { status: 404 });
      }
      const loc = path.match(/^\/locales\/([a-z]{2})\.json$/);
      if (loc) {
        const f = Bun.file('src/locales/' + loc[1] + '.json');
        return (await f.exists())
          ? new Response(f, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE } })
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE } });
      }
      const html = await buildHtml({ minify: false });
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE },
      });
    } catch (e) {
      return new Response(`Build error:\n\n${e.stack || e}`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
  // Relay each browser WebSocket to its localhost backend, buffering until the
  // upstream connection opens.
  websocket: {
    open(ws) {
      const up = new WebSocket(ws.data.target);
      ws.data.up = up;
      ws.data.q = [];
      up.onopen = () => { const q = ws.data.q; ws.data.q = null; for (const m of q) up.send(m); };
      up.onmessage = (e) => { try { ws.send(e.data); } catch {} };
      up.onclose = () => { try { ws.close(); } catch {} };
      up.onerror = () => { try { ws.close(); } catch {} };
    },
    message(ws, msg) {
      const up = ws.data.up;
      if (!up) return;
      if (up.readyState === 1) up.send(msg);
      else if (ws.data.q) ws.data.q.push(msg);
    },
    close(ws) { try { ws.data.up && ws.data.up.close(); } catch {} },
  },
});

console.log(`dev server → http://localhost:${port}  (also on 0.0.0.0:${port} for LAN/Tailscale)`);
