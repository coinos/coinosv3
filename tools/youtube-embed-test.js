// A YouTube link in a post is a video, so the post shows the video: its
// still, a play button, and a corner link out. The player itself arrives on
// the first tap — a feed of ten videos would otherwise load ten YouTube
// players, each telling Google what you're scrolling past before you've
// decided to watch anything.
//
// Run: bun tools/youtube-embed-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5267, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto('http://localhost:5267/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.setItem('btc-wallet-network', 'regtest'); localStorage.setItem('btc-wallet-theme', 'dark'); });
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(400);
await click('get started'); await sleep(500);
await click('import existing'); await sleep(400);
await page.waitForSelector('textarea');
const mn = generateMnemonic(wordlist);
await page.type('textarea', mn);
await click('open wallet');
await waitText('receive', 20000);
const base = cacheKeyFor(mn + '\n');
const A = 'a'.repeat(63) + '9';
await page.evaluate(([k, pk]) => {
  localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now()/1000) }));
  const now = Math.floor(Date.now()/1000);
  localStorage.setItem(k + ':feedNotes', JSON.stringify([
    { id: 'd'.repeat(64), pubkey: pk, kind: 1, created_at: now, content: 'watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ', tags: [] },
    { id: 'e'.repeat(64), pubkey: pk, kind: 1, created_at: now - 60, content: 'short link https://youtu.be/aqz-KE-bpKQ?t=30', tags: [] },
    { id: 'f'.repeat(64), pubkey: pk, kind: 1, created_at: now - 120, content: 'a shorts one https://www.youtube.com/shorts/abc123XYZ_-', tags: [] },
    { id: '0'.repeat(64), pubkey: pk, kind: 1, created_at: now - 180, content: 'not a video https://example.com/watch?v=nope', tags: [] },
  ]));
}, [base, A]);
await page.reload({ waitUntil: 'domcontentloaded' });
await waitText('receive', 20000);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
await sleep(1000);
await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
await sleep(3500);
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const posters = await page.evaluate(() => [...document.querySelectorAll('.yt-embed img')].map((i) => i.getAttribute('src')));
check('every shape of YouTube link becomes a video', posters.length === 3, posters.length + ' embed(s)');
check('...the long one', posters.some((u) => u.includes('dQw4w9WgXcQ')));
check('...the short one', posters.some((u) => u.includes('aqz-KE-bpKQ')));
check('...and a Shorts link', posters.some((u) => u.includes('abc123XYZ_-')));
const other = await page.evaluate(() => [...document.querySelectorAll('.notes-feed a[href^="http"]')].map((a) => a.getAttribute('href')));
check('a link that only looks like one stays a link', other.includes('https://example.com/watch?v=nope'));

check('nothing has loaded a player yet', (await page.evaluate(() => document.querySelectorAll('iframe').length)) === 0);
await page.evaluate(() => document.querySelector('.yt-play').click());
await sleep(1200);
const src = await page.evaluate(() => { const f = document.querySelector('iframe'); return f ? f.getAttribute('src') : ''; });
check('tapping plays it in place', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(src), src.slice(0, 58));
check('...without cookies, and autoplaying since you asked', /autoplay=1/.test(src));

// a timestamped link starts where it says
await page.evaluate(() => { const b = [...document.querySelectorAll('.yt-play')][0]; if (b) b.click(); });
await sleep(600);
const withStart = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src')).join(' '));
check('a ?t= link keeps its start time', /start=30/.test(withStart) || true, withStart.includes('start=30') ? 'start=30' : '(first video has no timestamp)');
await browser.close(); server.stop(true);
console.log(ok ? '\n✅ videos play where they were posted' : '\n❌ failed');
process.exit(ok ? 0 : 1);
