// Autoplay: a video in a post plays by itself, muted, while it is on screen,
// with a corner Unmute button; it pauses once scrolled away. A YouTube box
// loads its player muted when in view (with the same button) — nothing is
// loaded for a box that never comes into view. Set CLIP to a webm to serve;
// the default is made with ffmpeg on the fly.
// Run: bun tools/video-autoplay-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
import { existsSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const now = Math.floor(Date.now() / 1000);
const post = (content, ago) => finalizeEvent({ kind: 1, created_at: now - ago, tags: [], content }, SK);
const CLIP = process.env.CLIP || '/tmp/coinos-autoplay-clip.webm';
if (!existsSync(CLIP)) {
  const p = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-t', '2', '-c:v', 'libvpx', '-b:v', '50k', '-c:a', 'libvorbis', CLIP]);
  if (p.exitCode !== 0) { console.log('ffmpeg failed; set CLIP=<a webm>'); process.exit(1); }
}
const seeded = [
  post('watch this http://localhost:5301/clip.webm', 100),
  ...Array.from({ length: 6 }, (_, i) => post('filler post number ' + (i + 1) + ' to push the next one down the page ' + 'lorem ipsum '.repeat(40), 200 + i * 10)),
  post('and this one https://youtu.be/dQw4w9WgXcQ', 300),
];

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5301, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path === '/clip.webm') return new Response(Bun.file(CLIP), { headers: { 'content-type': 'video/webm' } });
  if (path.startsWith('/punks')) return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// YouTube itself is never contacted: what matters is what the box asks for
await page.setRequestInterception(true);
const ytRequests = [];
page.on('request', (r) => { if (/youtube|ytimg/.test(r.url())) { ytRequests.push(r.url()); r.abort(); } else r.continue(); });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5301/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Clip Poster', t: Date.now() } }));
  }, [base, AUTHOR, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'Feed'); if (e) e.click(); });

  const players = () => ytRequests.filter((u) => /youtube-nocookie\.com\/embed/.test(u)).length; // the poster still comes from ytimg, as before
  console.log('\n[a video in a post]');
  check('the post shows its video in a box with a sound button', await waitFor(() => !!document.querySelector('.note-video-box video') && !!document.querySelector('.note-video-box .vid-sound'), 20000));
  check('it is muted, and the button offers Unmute', await page.evaluate(() => { const v = document.querySelector('.note-video-box video'); const b = document.querySelector('.note-video-box .vid-sound'); return v.muted && /unmute/i.test(b.textContent); }));
  check('on screen, it plays by itself', await waitFor(() => { const v = document.querySelector('.note-video-box video'); return v && !v.paused && v.currentTime > 0; }, 8000),
    JSON.stringify(await page.evaluate(() => { const v = document.querySelector('.note-video-box video'); return v && { paused: v.paused, t: v.currentTime, err: v.error && v.error.code, ready: v.readyState }; })));
  await page.evaluate(() => document.querySelector('.note-video-box .vid-sound').click()); await sleep(200);
  check('Unmute turns the sound on and offers Mute', await page.evaluate(() => { const v = document.querySelector('.note-video-box video'); const b = document.querySelector('.note-video-box .vid-sound'); return !v.muted && /^\S+ mute$/i.test(b.textContent.trim()); }));
  await page.evaluate(() => window.scrollTo(0, 1000)); await sleep(700);
  check('scrolled away, it pauses', await waitFor(() => { const v = document.querySelector('.note-video-box video'); return v && v.paused; }, 4000));

  console.log('\n[a YouTube link]');
  const ytBefore = players();
  check('a box further down has not loaded a player', ytBefore === 0 && await page.evaluate(() => { const b = document.querySelector('.yt-embed'); return b && b.getBoundingClientRect().top > window.innerHeight; }), String(ytBefore));
  check('a box stands in for the player', await page.evaluate(() => !!document.querySelector('.yt-embed')));
  await page.evaluate(() => document.querySelector('.yt-embed').scrollIntoView({ block: 'center' })); await sleep(900);
  const src = await waitFor(() => !!document.querySelector('.yt-embed iframe'), 6000) ? await page.evaluate(() => document.querySelector('.yt-embed iframe').src) : '';
  check('in view, the player loads muted with autoplay and the API on', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(src) && /autoplay=1/.test(src) && /mute=1/.test(src) && /enablejsapi=1/.test(src) && /origin=/.test(src), src);
  check('...with the sound button over it', await page.evaluate(() => !!document.querySelector('.yt-embed .vid-sound')));
  await sleep(500);
  check('...and only then was a player asked for', ytBefore === 0 && players() > 0, ytBefore + ' → ' + players());
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ videos play by themselves, muted, while on screen' : '\n❌ failed');
process.exit(ok ? 0 : 1);
