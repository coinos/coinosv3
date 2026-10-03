// Feed media views: All / Images / Videos under the feed chips. Images is a
// grid of the feed's pictures; a tile opens the full-screen pager. Videos
// opens straight into the pager: one clip per screen, the one on screen
// playing, the next a flick (or ↓) away. The pager shows only the media
// until tapped: then the author, the words as a caption, likes and sats.
// Back and Escape close it.
// Run: bun tools/feed-media-views-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const dir = mkdtempSync(tmpdir() + '/media-');
const ff = (args) => { const p = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', ...args]); if (p.exitCode !== 0) throw new Error('ffmpeg failed'); };
for (const n of ['a', 'b']) ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/${n}.mp4`]);
for (const n of ['p1', 'p2', 'p3']) ff(['-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', `${dir}/${n}.jpg`]);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/v/')) return new Response(Bun.file(dir + path.slice(2)), { headers: { 'content-type': 'video/mp4' } });
  if (path.startsWith('/i/')) return new Response(Bun.file(dir + path.slice(2)), { headers: { 'content-type': 'image/jpeg' } });
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const base = server.url.origin;
const SK = generateSecretKey(), PK = getPublicKey(SK);
const FAN = generateSecretKey();
const now = Math.floor(Date.now() / 1000);
const post = (i, content) => finalizeEvent({ kind: 1, created_at: now - 100 - i * 60, tags: [], content }, SK);
const notes = [
  post(0, 'first clip, look at this ' + base + '/v/a.mp4'),
  post(1, 'a plain post with no media at all'),
  post(2, 'sunset over the bay ' + base + '/i/p1.jpg'),
  post(3, base + '/v/b.mp4'),
  post(4, 'two at once ' + base + '/i/p2.jpg ' + base + '/i/p3.jpg'),
];
const LIKE = finalizeEvent({ kind: 7, created_at: now - 50, tags: [['e', notes[2].id], ['p', PK]], content: '+' }, FAN);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((like) => {
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          const evs = (f.kinds || []).includes(7) && (f['#e'] || []).includes(like.tags[0][1]) ? [like] : [];
          setTimeout(() => {
            for (const ev of evs) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], ev]) }));
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
}, LIKE);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
const mode = (m) => page.evaluate((x) => document.querySelector(`.media-mode[data-mode="${x}"]`).click(), m);
const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
// which slide fills the screen, and what's playing
const pagerState = () => page.evaluate(() => {
  const p = document.querySelector('.media-pager');
  if (!p) return null;
  const sc = p.querySelector('.mp-scroll');
  const slides = [...sc.children];
  const i = Math.round(sc.scrollTop / sc.clientHeight);
  const vids = slides.map((s) => s.querySelector('video'));
  return { n: slides.length, i, src: (slides[i]?.querySelector('.mp-media')?.getAttribute('data-src') || '').split('/').pop(),
    playing: vids.map((v) => !!(v && !v.paused)), show: p.classList.contains('show'),
    meta: getComputedStyle(slides[i].querySelector('.mp-meta')).opacity };
});

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
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Shutterbug', t: Date.now() } }));
    localStorage.setItem('btc-wallet-feed:' + k, 'following');
  }, [key, PK, notes]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  await page.waitForSelector('.notes-feed:not([data-booting])', { timeout: 20000 });

  console.log('\n[the switch]');
  check('All / Images / Videos sit under the chips, All on', await page.evaluate(() =>
    [...document.querySelectorAll('.media-mode')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(',') === 'All*,Images,Videos'));

  console.log('\n[Images: a grid]');
  await mode('images');
  check('the feed becomes a grid of its pictures, one tile each', await waitFor(() => document.querySelectorAll('.media-grid .media-tile').length === 3, 8000),
    String(await page.evaluate(() => document.querySelectorAll('.media-grid .media-tile').length)));
  check('...and the posts themselves are gone', await page.evaluate(() => !document.querySelector('.notes-feed')));
  await shot('grid');
  await page.evaluate(() => document.querySelectorAll('.media-grid .media-tile')[1].click());
  check('a tile opens the pager', await waitFor(() => !!document.querySelector('.media-pager'), 4000));
  await sleep(400);
  let st = await pagerState();
  check('...on that picture, among all three', st && st.n === 3 && st.src === 'p2.jpg', JSON.stringify(st));
  check('...with nothing over it', st && !st.show && st.meta === '0');
  await shot('pager-bare');
  await page.evaluate(() => { const p = document.querySelector('.media-pager'); p.querySelector('.mp-slide').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await sleep(300);
  st = await pagerState();
  const meta = await page.evaluate(() => { const s = [...document.querySelectorAll('.mp-slide')][Math.round(document.querySelector('.mp-scroll').scrollTop / document.querySelector('.mp-scroll').clientHeight)]; return { author: s.querySelector('.mp-author > span:last-child').textContent, caption: s.querySelector('.mp-caption')?.textContent }; });
  check('a tap shows the author and the words, without the links', st.show && st.meta === '1' && meta.author === 'Shutterbug' && meta.caption === 'two at once', JSON.stringify(meta));
  await page.keyboard.press('ArrowUp'); await sleep(900);
  st = await pagerState();
  check('↑ goes to the previous picture', st.src === 'p1.jpg', JSON.stringify(st));
  check('its like shows in the corner', await waitFor(() => { const p = document.querySelector('.media-pager'); const sc = p.querySelector('.mp-scroll'); const s = sc.children[Math.round(sc.scrollTop / sc.clientHeight)]; return s.querySelector('.mp-like .n').textContent === '1'; }, 6000));
  await shot('pager-meta');
  await page.goBack(); await sleep(600);
  check('Back closes the pager, leaving the grid', await page.evaluate(() => !document.querySelector('.media-pager') && !!document.querySelector('.media-grid')));
  check('...and the page scrolls again', await page.evaluate(() => !document.documentElement.classList.contains('no-scroll')));

  console.log('\n[Videos: flip through]');
  await mode('videos');
  check('Videos opens straight into the pager', await waitFor(() => !!document.querySelector('.media-pager.videos'), 4000));
  check('...the first clip playing', await waitFor(() => { const v = document.querySelector('.media-pager video'); return v && !v.paused && v.currentTime > 0; }, 8000), JSON.stringify(await pagerState()));
  st = await pagerState();
  check('...two clips in all, nothing over them, sound on', st.n === 2 && st.src === 'a.mp4' && !st.show && st.meta === '0'
    && await page.evaluate(() => !document.querySelector('.media-pager video').muted), JSON.stringify(st));
  await page.keyboard.press('ArrowDown'); await sleep(1200);
  st = await pagerState();
  check('↓ flips to the next, which plays while the first stops', st.i === 1 && st.src === 'b.mp4' && st.playing[1] && !st.playing[0], JSON.stringify(st));
  await shot('videos');
  await page.keyboard.press('Escape'); await sleep(600);
  check('Escape closes it, leaving a grid of the clips', await page.evaluate(() => !document.querySelector('.media-pager') && document.querySelectorAll('.media-grid .media-tile.video').length === 2));
  check('no clip goes on playing behind', await page.evaluate(() => [...document.querySelectorAll('video')].every((v) => v.paused)));

  console.log('\n[remembered]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  check('the feed opens on the view last chosen', await waitFor(() => document.querySelector('.media-mode.on')?.dataset.mode === 'videos' && !!document.querySelector('.media-grid'), 15000));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ media views: a grid of pictures, videos to flip through' : '\n❌ failed');
process.exit(ok ? 0 : 1);
