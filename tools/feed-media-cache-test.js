// The media index: Videos finds clips far down a feed by crawling the
// relays straight into its own cache (100 posts a time, not held up by a
// slow picture), a reload paints the grid from that cache at once and
// resumes the crawl where it stopped, and tile frames are kept as pictures.
// Run: bun tools/feed-media-cache-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const dir = mkdtempSync(tmpdir() + '/mcache-');
const ff = (args) => { const p = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', ...args]); if (p.exitCode !== 0) throw new Error('ffmpeg failed'); };
for (const n of ['v1', 'v2', 'v3']) ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/${n}.mp4`]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', `${dir}/slow.jpg`]);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: async (req) => {
  const path = new URL(req.url).pathname;
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-length' };
  if (path.startsWith('/v/')) {
    const f = Bun.file(dir + path.slice(2));
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
    if (m) {
      const a = +m[1], b = Math.min(m[2] ? +m[2] : f.size - 1, f.size - 1);
      return new Response(f.slice(a, b + 1), { status: 206, headers: { ...cors, 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${f.size}`, 'accept-ranges': 'bytes' } });
    }
    return new Response(f, { headers: { ...cors, 'content-type': 'video/mp4' } });
  }
  // a picture that takes ten seconds: the crawl must not wait on it
  if (path === '/i/slow.jpg') { await sleep(10000); return new Response(Bun.file(dir + '/slow.jpg'), { headers: { 'content-type': 'image/jpeg' } }); }
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const base = server.url.origin;
const SK = generateSecretKey(), PK = getPublicKey(SK);
const now = Math.floor(Date.now() / 1000);
const post = (i, content) => finalizeEvent({ kind: 1, created_at: now - 100 - i * 60, tags: [], content }, SK);
// 40 text posts on top, then the media further down, more text in between
const all = [];
for (let i = 0; i < 40; i++) all.push(post(i, 'just words, number ' + i));
all.push(post(40, 'a slow picture ' + base + '/i/slow.jpg'));
all.push(post(41, 'first clip ' + base + '/v/v1.mp4'));
for (let i = 42; i < 60; i++) all.push(post(i, 'more words ' + i));
all.push(post(60, 'second clip ' + base + '/v/v2.mp4'));
for (let i = 61; i < 150; i++) all.push(post(i, 'deep words ' + i));
all.push(post(150, 'third clip, far down ' + base + '/v/v3.mp4'));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(([evs, pk]) => {
  window.__reqs = [];
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          let out = [];
          if ((f.kinds || []).includes(1) && (f.authors || []).includes(pk) && !f['#e'] && !f.ids) {
            window.__reqs.push({ until: f.until, limit: f.limit });
            out = evs.filter((e) => !f.until || e.created_at <= f.until).slice(0, f.limit || 30);
          }
          setTimeout(() => {
            for (const ev of out) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], ev]) }));
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
          }, 0);
          return;
        }
        if (m[0] === 'EVENT') return;
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
}, [all, PK]);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await page.evaluate(fn)) return true; await sleep(100); } return false; };
const tiles = () => page.evaluate(() => document.querySelectorAll('.media-grid .media-tile.video').length);
const openFeed = async () => {
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  await waitFor(() => !!document.querySelector('.media-modes'), 20000);
};

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const key = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pk]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Deep Poster', t: Date.now() } }));
    localStorage.setItem('btc-wallet-feed:' + k, 'following');
  }, [key, PK]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await openFeed();
  await waitFor(() => window.__reqs.length > 0, 10000);
  await sleep(1500);

  console.log('\n[a crawl straight into the media index]');
  const t0 = Date.now();
  await page.evaluate(() => { window.__reqs = []; document.querySelector('.media-mode[data-mode="videos"]').click(); });
  check('all three clips are found, the deepest 150 posts down', await waitFor(() => document.querySelectorAll('.media-grid .media-tile.video').length === 3, 15000), String(await tiles()));
  const took = Date.now() - t0;
  check('...without waiting on the slow picture along the way', took < 8000, took + ' ms');
  const reqs = await page.evaluate(() => window.__reqs);
  const steps = [...new Set(reqs.map((r) => r.until))]; // each step asks every relay
  check('...asking a hundred posts at a time, each step older than the last', reqs.length >= 1 && reqs.every((r) => r.limit === 100 && r.until)
    && steps.every((u, i) => !i || u < steps[i - 1]), JSON.stringify(steps));
  check('tile frames are kept as pictures', await waitFor(async () => (await (await caches.open('coinos-video-thumbs-v1')).keys()).length === 3, 8000));
  await sleep(2000); // the index's write-behind

  console.log('\n[a reload]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { window.__reqs = []; });
  const t1 = Date.now();
  await openFeed();
  check('the grid paints from the index at once', await waitFor(() => document.querySelectorAll('.media-grid .media-tile.video').length === 3, 4000), (Date.now() - t1) + ' ms');
  check('...its tiles pictures from the kept frames, no player needed', await waitFor(() => [...document.querySelectorAll('.media-grid .media-tile.video img')].filter((i) => i.src.startsWith('blob:')).length === 3, 4000));
  await sleep(2500);
  const after = await page.evaluate(() => window.__reqs.filter((r) => r.limit === 100));
  const deepest = all.find((e) => /far down/.test(e.content)).created_at;
  check('...and nothing is crawled again from the top', after.every((r) => r.until <= deepest), JSON.stringify(after));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ media index: crawled once, painted at once after a reload' : '\n❌ failed');
process.exit(ok ? 0 : 1);
