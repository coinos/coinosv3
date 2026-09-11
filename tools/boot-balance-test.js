// The wallet must not paint before the ark store has opened. The Spending
// balance and its history are read from that store, which is IndexedDB:
// synchronous to read, asynchronous to OPEN. Painting first showed an empty
// Spending wallet for a beat and then filled it in — a layout shift on every
// refresh, and a balance that counted itself up from 0 in green, wearing the
// animation a received payment gets.
//
// IndexedDB is slowed here by a fixed delay, so the ordering is unambiguous:
// we record when the ark store's open resolves and when the balance card
// first appears, on a RELOAD (session restore — the case the user sees).
//
// Run: bun tools/boot-balance-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = 400;
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5233, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5233/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('get started'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('open wallet');
  await waitText('receive', 20000);

  // now the measured reload
  await page.evaluateOnNewDocument((delay) => {
    window.__idb = {};
    const orig = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, ...a) => {
      const req = orig(name, ...a);
      window.__idb[name] = { called: performance.now() };
      let fn = null;
      Object.defineProperty(req, 'onsuccess', { set(v) { fn = v; }, get() { return fn; }, configurable: true });
      req.addEventListener('success', () => {
        setTimeout(() => { window.__idb[name].done = performance.now(); if (fn) fn.call(req, new Event('success')); }, delay);
      });
      return req;
    };
    const mark = () => { if (!window.__balAt && document.querySelector('.balance')) window.__balAt = performance.now(); };
    // documentElement doesn't exist yet at this point — poll on a frame loop,
    // which resolves the first paint finely enough for this comparison.
    const tick = () => { mark(); if (!window.__balAt) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, DELAY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const r = await page.evaluate(() => ({ idb: window.__idb, bal: window.__balAt, cls: [...document.querySelectorAll('#app *')].map((e) => e.className).filter((c) => typeof c === 'string' && c).slice(0, 25) }));
  console.log('idb opens:', JSON.stringify(r.idb));
  const ark = r.idb['coinos-ark'] || {};
  console.log(`ark store: open called ${Math.round(ark.called)}ms, resolved ${Math.round(ark.done)}ms; balance card painted ${Math.round(r.bal)}ms`);
  const ok = r.bal >= ark.done;
  console.log(ok ? ' ✓ the wallet waits for the store' : ' ✗ the wallet paints first (empty Spending, then a jump)');
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); server.stop(true); }
process.exit(process.exitCode || 0);
