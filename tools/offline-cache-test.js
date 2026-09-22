// What an offline boot has to show: the room's recent messages from the
// local cache (written as they ARRIVE, not only when we send), names from
// the profile cache and most faces from local thumbnails. Boots the PWA
// build from dist/ so the service worker serves the shell offline.
//
// Run: bun run build && bun tools/offline-cache-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { join } from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = join(import.meta.dir, '../dist');
const server = Bun.serve({ port: 5234, async fetch(req) {
  const u = new URL(req.url); let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const f = Bun.file(dist + p);
  if (await f.exists()) return new Response(f, { headers: { 'cache-control': 'no-store' } });
  return new Response(Bun.file(dist + '/index.html'), { headers: { 'cache-control': 'no-store' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };
const openMessages = () => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /message/i.test(b.getAttribute('aria-label') || ''))?.click());
const openCoinos = () => page.evaluate(() => { const e = [...document.querySelectorAll('.chat-thread-row')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'coinos'); if (e) e.click(); });
const snap = () => page.evaluate(() => ({
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  bubbles: document.querySelectorAll('.chat-bubble').length,
  rows: document.querySelectorAll('.chat-thread-row').length,
  avaImg: document.querySelectorAll('.ava-img').length,
  avaImgData: [...document.querySelectorAll('.ava-img')].filter((e) => /url\("?data:/.test(e.style.backgroundImage)).length,
  fallback: document.querySelectorAll('.chat-avatar.fallback').length,
  header: !!document.querySelector('.header-ava'),
  headerIsImg: !!document.querySelector('.header-ava.ava-img'),
  offlineBanner: document.body.innerText.includes('offline') || document.body.innerText.includes('Offline'),
}));
await page.setViewport({ width: 420, height: 860 });
await page.goto('http://localhost:5234/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
await click('button', 'Create a new wallet'); await sleep(300);
await click('button', 'Have an existing seed'); await sleep(300);
await page.waitForSelector('textarea'); await page.type('textarea', generateMnemonic(wordlist));
await click('button', 'Open wallet'); await waitText('receive', 15000);
await openMessages(); await sleep(800); await openCoinos();
console.log('online room:', await waitText('GM Coinos community', 30000));
await sleep(6000); // thumbnails, profiles, caches settle
console.log('online snapshot:', JSON.stringify(await snap()));
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const ks = await caches.keys(); const c = ks.length ? await (await caches.open(ks[0])).keys() : []; return { reg: !!r, active: !!(r && r.active), caches: ks, cached: c.length }; });
console.log('sw:', JSON.stringify(sw));
const cdp = await page.target().createCDPSession(); await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(500);
try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (e) { console.log('reload:', e.message.slice(0, 100)); }
await sleep(5000);
console.log('offline boot:', JSON.stringify(await snap()));
await openMessages(); await sleep(1500);
console.log('offline messages home:', JSON.stringify(await snap()));
await openCoinos(); await sleep(1500);
const room = await snap();
console.log('offline room:', JSON.stringify(room).slice(0, 300));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
check('the room shows cached messages offline', room.bubbles >= 20, `${room.bubbles} bubbles`);
check('most faces paint from local thumbnails', room.avaImgData >= room.avaImg * 0.6, `${room.avaImgData} of ${room.avaImg}`);
check('names resolve from the profile cache', !/npub1[a-z0-9]{8}/.test(room.text.slice(0, 120)) || room.text.includes('Adam'), room.text.slice(40, 120));
await page.screenshot({ path: process.argv[2] || '/tmp/offline.png' });
await browser.close(); server.stop(true);
console.log(ok ? '\nALL GOOD' : '\nFAILURES');
process.exit(ok ? 0 : 1);
