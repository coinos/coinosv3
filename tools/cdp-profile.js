// Main-thread CPU profile of the live app through Chrome's remote debugging
// port (laptop: chrome --remote-debugging-port=9222; phone: adb forward
// tcp:9223 localabstract:chrome_devtools_remote — the page must be
// foreground/unlocked, a frozen background tab never answers).
//   bun tools/cdp-profile.js --port 9222 --mode reload --seconds 10
//   --mode refocus   simulate background→foreground (Page.setWebLifecycleState)
//   --mode wait      start sampling, then do the action by hand (or adb)
//   --serve dist     answer same-origin requests from a local build (SW bypassed)
//                    so an unreleased fix can be profiled in the real tab
//   --out f.cpuprofile   keep the raw profile for tools/cdp-callers.js
// Prints busy-per-250ms buckets, self time by file/function, inclusive time.
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = args.port || 9222, mode = args.mode || 'idle', seconds = Number(args.seconds || 8), match = args.match || 'coinos.io';
const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes(match));
if (!page) { console.error('no page matching', match); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } else if (d.method) events.push(d); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable'); await send('Page.enable'); await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: Number(args.interval || 500) });
if (args.serve) {
  // serve the local build into the live tab: bypass the SW, answer every same-origin request from dist/
  const fs = await import('fs'); const path = await import('path');
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  await send('Network.enable'); await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: `https://${new URL(page.url).host}/*`, requestStage: 'Request' }] });
  const origOnMessage = ws.onmessage;
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Fetch.requestPaused') {
    const u = new URL(d.params.request.url); let rel = u.pathname === '/' ? '/index.html' : u.pathname;
    if (u.pathname === '/sw.js') { send('Fetch.continueRequest', { requestId: d.params.requestId }); return; }
    const f = path.join(args.serve, rel);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const body = fs.readFileSync(f).toString('base64');
      send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: types[path.extname(f)] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }], body });
    } else send('Fetch.continueRequest', { requestId: d.params.requestId });
    return; } origOnMessage(m); };
}
const t0 = Date.now();
await send('Profiler.start');
if (mode === 'reload') { await send('Page.reload', { ignoreCache: false }); }
else if (mode === 'refocus') {
  await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  await send('Page.setWebLifecycleState', { state: 'frozen' }); await sleep(Number(args.away || 3000));
  await send('Page.setWebLifecycleState', { state: 'active' });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
} else if (mode === 'wait') { console.log('profiler running; do the action now'); }
await sleep(seconds * 1000);
const { profile } = await send('Profiler.stop');
if (args.serve) { await send('Fetch.disable'); await send('Network.setBypassServiceWorker', { bypass: false }); }
ws.close();
// ---- analysis
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const self = new Map(); const total = new Map();
const dt = profile.timeDeltas; const samples = profile.samples;
let t = profile.startTime; const buckets = new Map(); let busy = 0, all = 0; const first = profile.startTime;
const isIdle = (n) => ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(n.callFrame.functionName) && !n.callFrame.url;
for (let i = 0; i < samples.length; i++) {
  t += dt[i]; const n = nodes.get(samples[i]); const d = dt[i + 1] || 0; all += d;
  const idle = n.callFrame.functionName === '(idle)';
  if (!idle) { busy += d; const b = Math.floor((t - first) / 1000 / 250); buckets.set(b, (buckets.get(b) || 0) + d); }
  self.set(n.id, (self.get(n.id) || 0) + d);
  const seen = new Set(); let p = n.id; while (p != null) { const key = fnKey(nodes.get(p)); if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) || 0) + d); } p = parent.get(p); }
}
function fnKey(n) { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.replace(/^https?:\/\/[^/]+/, '')}:${f.lineNumber + 1}:${f.columnNumber + 1}`; }
const selfByFn = new Map(); for (const [nid, ms] of self) { const k = fnKey(nodes.get(nid)); selfByFn.set(k, (selfByFn.get(k) || 0) + ms); }
const selfByUrl = new Map(); for (const [nid, ms] of self) { const f = nodes.get(nid).callFrame; const k = f.url ? f.url.replace(/^https?:\/\/[^/]+/, '') : f.functionName; selfByUrl.set(k, (selfByUrl.get(k) || 0) + ms); }
const ms = (us) => (us / 1000).toFixed(1);
console.log(`mode=${mode} page=${page.url} sampled ${ms(all)}ms wall, busy ${ms(busy)}ms (${(100 * busy / all).toFixed(0)}%)`);
console.log('\n== busy per 250ms bucket (ms) ==');
const maxB = Math.max(...buckets.keys()); let line = '';
for (let b = 0; b <= maxB; b++) { const v = (buckets.get(b) || 0) / 1000; line += v.toFixed(0).padStart(4); if ((b + 1) % 16 === 0) { console.log(`${(b - 15) * 0.25}s:`.padStart(7) + line); line = ''; } }
if (line) console.log(`${(Math.floor(maxB / 16) * 16) * 0.25}s:`.padStart(7) + line);
console.log('\n== self time by url ==');
for (const [k, v] of [...selfByUrl].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(ms(v).padStart(8), k);
console.log('\n== top self time by function ==');
for (const [k, v] of [...selfByFn].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top || 40))) console.log(ms(v).padStart(8), k);
console.log('\n== top total (inclusive) time by function ==');
for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top || 40))) { if (k.startsWith('(root)') || k.startsWith('(program)') || k.startsWith('(idle)')) continue; console.log(ms(v).padStart(8), k); }
if (args.out) await Bun.write(args.out, JSON.stringify(profile));
