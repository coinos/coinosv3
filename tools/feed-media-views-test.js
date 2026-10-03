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
for (const n of ['a', 'b', 'c']) ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/${n}.mp4`]);
// index last (no faststart), from a server that ignores ranges
ff(['-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${dir}/slow.mp4`]);
for (const n of ['p1', 'p2', 'p3']) ff(['-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', `${dir}/${n}.jpg`]);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/v/')) {
    const f = Bun.file(dir + path.slice(2));
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
    if (m && path !== '/v/slow.mp4') {
      const a = +m[1], b = Math.min(m[2] ? +m[2] : f.size - 1, f.size - 1);
      // c.mp4 stands in for a 50 MB file: its server says so
      const total = path === '/v/c.mp4' && m[2] === '65535' ? 50000000 : f.size; // (to the probe; a player gets the real file)
      return new Response(f.slice(a, b + 1), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${total}`, 'accept-ranges': 'bytes' } });
    }
    return new Response(f, { headers: { 'content-type': 'video/mp4' } });
  }
  if (path.startsWith('/i/')) return new Response(Bun.file(dir + path.slice(2)), { headers: { 'content-type': 'image/jpeg' } });
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const base = server.url.origin;
const SK = generateSecretKey(), PK = getPublicKey(SK);
const FAN = generateSecretKey();
const now = Math.floor(Date.now() / 1000);
const post = (i, content, tags = []) => finalizeEvent({ kind: 1, created_at: now - 100 - i * 60, tags, content }, SK);
const notes = [
  post(0, 'first clip, look at this ' + base + '/v/a.mp4'),
  post(1, 'a plain post with no media at all'),
  post(2, 'sunset over the bay ' + base + '/i/p1.jpg'),
  post(3, base + '/v/b.mp4'),
  post(4, 'two at once ' + base + '/i/p2.jpg ' + base + '/i/p3.jpg'),
  // the post says this one is 50 MB (it isn't; the post is believed)
  post(5, 'a huge clip ' + base + '/v/c.mp4', [['imeta', 'url ' + base + '/v/c.mp4', 'm video/mp4', 'size 50000000', 'dim 360x640']]),
  post(6, 'index last ' + base + '/v/slow.mp4'),
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

  console.log('\n[the big clip in the feed]');
  await mode('all'); await sleep(800);
  await page.evaluate(() => { const v = [...document.querySelectorAll('.note-video-box video')].find((x) => /c\.mp4/.test(x.getAttribute('src') || x.getAttribute('data-lazy-src') || '')); v.scrollIntoView({ block: 'center' }); });
  check('it waits under a cover with its size', await waitFor(() => [...document.querySelectorAll('.note-video-box .vid-heavy')].some((b) => /50 MB/.test(b.textContent)), 8000));
  check('feed clips fetch nothing until they play', await page.evaluate(() => [...document.querySelectorAll('.note-video-box video')].every((v) => v.preload === 'none' || !v.paused)));
  console.log('\n[Videos: flip through]');
  const info = () => page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('coinos-video-info') || '[]').map(([u, d]) => [u.split('/').pop(), d])));
  const srcs = () => page.evaluate(() => [...document.querySelectorAll('.media-pager video')].map((v) => ({ src: !!v.getAttribute('src'), pre: v.preload })));
  await mode('videos');
  check('Videos shows a grid of the vertical clips, not the pager yet', await waitFor(() => document.querySelectorAll('.media-grid .media-tile.video').length === 3, 8000)
    && await page.evaluate(() => !document.querySelector('.media-pager')));
  check('every tile gets a thumbnail — the 50 MB one too, with its cost as a badge', await waitFor(() =>
    [...document.querySelectorAll('.media-tile video')].filter((v) => v.getAttribute('src')).length === 3
    && [...document.querySelectorAll('.media-tile-badge')].some((x) => /50 MB/.test(x.textContent)), 8000));
  await shot('video-grid');
  await page.evaluate(() => document.querySelector('.media-grid .media-tile.video').click());
  check('the first tile opens the pager', await waitFor(() => !!document.querySelector('.media-pager.videos'), 4000));
  check('...the first clip playing', await waitFor(() => { const v = document.querySelector('.media-pager video'); return v && !v.paused && v.currentTime > 0; }, 8000), JSON.stringify(await pagerState()));
  st = await pagerState();
  check('...the three vertical clips, nothing over them, sound on', st.n === 3 && st.src === 'a.mp4' && !st.show && st.meta === '0'
    && await page.evaluate(() => !document.querySelector('.media-pager video').muted), JSON.stringify(st));
  await waitFor(() => { const v = document.querySelectorAll('.media-pager video')[1]; return v && !!v.getAttribute('src'); }, 5000);
  let ss = await srcs();
  check('only the clip on screen loads in full; the next gets its opening; the rest nothing',
    ss[0].src && ss[0].pre === 'auto' && ss[1].src && ss[1].pre === 'metadata' && !ss[2].src, JSON.stringify(ss));
  await waitFor(() => Object.keys(JSON.parse(localStorage.getItem('coinos-video-info') || '[]')).length >= 3, 6000);
  await sleep(1500);
  const vi = await info();
  check('a probe reads the size, ranges, layout and picture size from 64 KB', vi['a.mp4']?.probed && vi['a.mp4'].ranges && vi['a.mp4'].faststart
    && vi['a.mp4'].size > 1000 && vi['a.mp4'].w === 360 && vi['a.mp4'].h === 640, JSON.stringify(vi['a.mp4']));
  check('the landscape clip is left out of Videos', !(await page.evaluate(() => [...document.querySelectorAll('.media-pager video')].some((v) => /slow/.test(v.getAttribute('data-src'))))));
  check('an index-last file from a server without ranges is seen for what it is', vi['slow.mp4']?.probed && vi['slow.mp4'].faststart === false && vi['slow.mp4'].ranges === false, JSON.stringify(vi['slow.mp4']));
  check('the 50 MB clip is known as such before any of it plays', vi['c.mp4']?.size === 50000000, JSON.stringify(vi['c.mp4']));
  await page.keyboard.press('ArrowDown'); await sleep(1200);
  st = await pagerState();
  check('↓ flips to the next, which plays while the first stops', st.i === 1 && st.src === 'b.mp4' && st.playing[1] && !st.playing[0], JSON.stringify(st));
  ss = await srcs();
  check('...and the window moves with it: the first lets go, the big one is not fetched as next', !ss[0].src && ss[1].pre === 'auto' && !ss[2].src, JSON.stringify(ss));
  await page.keyboard.press('ArrowDown'); await sleep(1200);
  st = await pagerState();
  check('the 50 MB clip waits for a tap, saying what it costs', st.src === 'c.mp4' && await page.evaluate(() => {
    const s = document.querySelectorAll('.mp-slide')[2]; const b = s.querySelector('.vid-heavy');
    return !!b && /50 MB/.test(b.textContent) && !/^[^#]*$/.test(s.querySelector('video').getAttribute('src') || '#'); }), JSON.stringify(st));
  check('...over a picture of it (the kept frame, or the first frame itself)', await waitFor(() => {
    const v = document.querySelectorAll('.mp-slide')[2].querySelector('video');
    return (v.getAttribute('poster') || '').startsWith('blob:') || (/#t=/.test(v.getAttribute('src') || '') && v.readyState >= 2); }, 5000));
  await shot('heavy');
  await page.evaluate(() => document.querySelectorAll('.mp-slide')[2].querySelector('.vid-heavy').click());
  check('a tap plays it', await waitFor(() => { const v = document.querySelectorAll('.media-pager video')[2]; return !v.paused && v.currentTime > 0; }, 6000));
  check('...without showing the overlay', !(await pagerState()).show);
  await page.keyboard.press('Escape'); await sleep(600);
  check('Escape closes it, leaving a grid of the clips', await page.evaluate(() => !document.querySelector('.media-pager') && document.querySelectorAll('.media-grid .media-tile.video').length === 3));
  check('no clip goes on playing behind', await page.evaluate(() => [...document.querySelectorAll('video')].every((v) => v.paused)));

  console.log('\n[the setting]');
  await page.evaluate(() => localStorage.setItem('coinos-video-large', '1'));
  await mode('videos');
  await waitFor(() => !!document.querySelector('.media-grid .media-tile.video'), 4000);
  await page.evaluate(() => document.querySelector('.media-grid .media-tile.video').click());
  await waitFor(() => !!document.querySelector('.media-pager.videos'), 4000);
  await page.keyboard.press('ArrowDown'); await sleep(900); await page.keyboard.press('ArrowDown'); await sleep(1500);
  check('with "Autoplay large videos" on, it plays by itself', await page.evaluate(() => { const s = document.querySelectorAll('.mp-slide')[2]; const v = s.querySelector('video'); return !s.querySelector('.vid-heavy') && !v.paused; }));
  await page.keyboard.press('Escape'); await sleep(400);
  await page.evaluate(() => localStorage.removeItem('coinos-video-large'));

  console.log('\n[remembered]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  check('the feed opens on the view last chosen', await waitFor(() => document.querySelector('.media-mode.on')?.dataset.mode === 'videos' && !!document.querySelector('.media-grid'), 15000));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ media views: a grid of pictures, videos to flip through' : '\n❌ failed');
process.exit(ok ? 0 : 1);
