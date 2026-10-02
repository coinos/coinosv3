// A video in the feed paints at its own shape, not a 16:9 frame with black
// bands either side: from the post's imeta `dim` when it says, else from the
// clip's metadata fetched before the row is admitted. A clip with no known
// shape still gets the 16:9 box.
// Photos too: a big one paints from a column-sized copy (see makeMediaThumb).
// Run: bun tools/feed-video-aspect-test.js   (CHROME=<path> to pick a browser)
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const dir = mkdtempSync(tmpdir() + '/vid-');
const clip = (name, size) => {
  const p = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`, '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/${name}`]);
  if (p.exitCode !== 0) throw new Error('ffmpeg failed');
};
clip('tall.mp4', '360x480'); clip('wide.mp4', '640x360'); clip('told.mp4', '360x640');
// photos: a camera-sized one (painted from a column-sized copy) and a small one
const photo = (name, size) => {
  const p = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', `${dir}/${name}`]);
  if (p.exitCode !== 0) throw new Error('ffmpeg failed');
};
photo('big.jpg', '3000x2000'); photo('small.jpg', '800x600');

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: async (req) => {
  const path = new URL(req.url).pathname;
  // this one's metadata arrives too late for a probe: only the imeta dim can shape it
  if (path === '/v/told.mp4') await sleep(6000);
  if (path.startsWith('/v/')) return new Response(Bun.file(dir + path.slice(2)), { headers: { 'content-type': 'video/mp4' } });
  if (path.startsWith('/i/')) return new Response(Bun.file(dir + path.slice(2)), { headers: { 'content-type': 'image/jpeg' } });
  if (path === '/broken.mp4') return new Response('nope', { status: 404 });
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const base = server.url.origin;
const SK = generateSecretKey(), PK = getPublicKey(SK);
const now = Math.floor(Date.now() / 1000);
const post = (i, content, tags = []) => finalizeEvent({ kind: 1, created_at: now - 100 - i * 60, tags, content }, SK);
const notes = [
  post(0, 'tall clip ' + base + '/v/tall.mp4'),
  post(1, 'wide clip ' + base + '/v/wide.mp4'),
  // imeta says 9:16; the file is too, but the probe must not be needed
  post(2, 'told clip ' + base + '/v/told.mp4', [['imeta', 'url ' + base + '/v/told.mp4', 'm video/mp4', 'dim 1080x1920']]),
  post(3, 'broken clip ' + base + '/broken.mp4'),
  post(4, 'big photo ' + base + '/i/big.jpg'),
  post(5, 'small photo ' + base + '/i/small.jpg'),
];

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const videoReqs = [];
page.on('request', (r) => { if (/\/v\/told\.mp4/.test(r.url())) videoReqs.push(Date.now()); });
await page.evaluateOnNewDocument(() => {
  // no autoplay: a clip that played keeps its first box, and this test is
  // about the box the settled feed row paints
  HTMLMediaElement.prototype.play = function () { return Promise.reject(new Error('no autoplay in this test')); };
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') { setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) })), 0); return; }
        if (m[0] === 'EVENT') return;
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
// each clip's box, as painted in the feed (before any metadata of its own)
const boxes = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.notes-feed video.note-video')].map((v) => {
  const r = v.getBoundingClientRect();
  return [(v.getAttribute('src') || v.getAttribute('data-lazy-src') || '').split('/').pop(), { w: Math.round(r.width), h: Math.round(r.height), style: v.getAttribute('style') }];
})));

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
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Clipper', t: Date.now() } }));
    localStorage.setItem('btc-wallet-feed:' + k, 'following'); // this wallet's last feed
  }, [key, PK, notes]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  videoReqs.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  await page.waitForSelector('.notes-feed:not([data-booting]) video.note-video', { timeout: 20000 });
  const b = await boxes();
  const ratio = (x) => x && x.h ? +(x.w / x.h).toFixed(2) : 0;
  check('a 3:4 clip, measured ahead, paints at 3:4 full width', ratio(b['tall.mp4']) === 0.75 && b['tall.mp4'].w > 300 && /aspect-ratio:360\/480/.test(b['tall.mp4'].style || ''), JSON.stringify(b['tall.mp4']));
  check('a 16:9 clip stays 16:9', Math.abs(ratio(b['wide.mp4']) - 1.78) < 0.02 && /aspect-ratio:640\/360/.test(b['wide.mp4'].style || ''), JSON.stringify(b['wide.mp4']));
  check('a clip whose post gives imeta dim paints at that shape, without waiting on the file', Math.abs(ratio(b['told.mp4']) - 0.56) < 0.02 && /aspect-ratio:1080\/1920/.test(b['told.mp4'].style || ''), JSON.stringify(b['told.mp4']));
  check('...full width, no taller than the screen', b['told.mp4'] && b['told.mp4'].w > 300 && b['told.mp4'].h <= 845, JSON.stringify(b['told.mp4']));
  check('a clip that will not load keeps the 16:9 box', /aspect-ratio:16\/9/.test(b['broken.mp4']?.style || ''), JSON.stringify(b['broken.mp4']));
  // a camera-sized photo paints from a column-sized copy, decoded with the page
  const imgs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.notes-feed img.note-img')].map((i) => [
    i.closest('.row').innerText.includes('big photo') ? 'big' : 'small', { src: i.src.slice(0, 5), nw: i.naturalWidth, dec: i.decoding, ar: i.style.aspectRatio }])));
  check('a 3000px photo paints from an 1100px copy', imgs.big && imgs.big.src === 'blob:' && imgs.big.nw === 1100 && imgs.big.dec === 'sync', JSON.stringify(imgs.big));
  check('...keeping the original shape', imgs.big && imgs.big.ar.replace(/\s/g, '') === '3000/2000', JSON.stringify(imgs.big));
  check('a small photo is its own original', imgs.small && imgs.small.src === 'http:' && imgs.small.nw === 800, JSON.stringify(imgs.small));
  check('the copy is kept on disk for the next visit', await page.evaluate(async () => !!(await (await caches.open('coinos-media-thumbs-v1')).match(location.origin + '/i/big.jpg'))));
  await sleep(1500);
  check('shapes are remembered on the device', await page.evaluate(() => (JSON.parse(localStorage.getItem('coinos-video-dims') || '[]')).length >= 3));
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  console.log('✗ threw', e.stack); ok = false;
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ feed videos paint at their own shape' : '\n❌ failed');
process.exit(ok ? 0 : 1);
