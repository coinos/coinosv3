// Zap tallies are asked of the relays on every boot, which takes seconds. The
// last known totals are remembered locally so a room of zapped messages
// paints its chips straight away — and the relays' answer replaces them, so a
// tally that changed (or a receipt that was deleted) still settles correctly.
//
// Run: bun tools/zap-tally-cache-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
import { cacheKeyFor } from '../src/wallet.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5236, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5236/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('get started'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  const mnemonic = generateMnemonic(wordlist);
  await page.type('textarea', mnemonic);
  await click('open wallet');
  await waitText('receive', 20000);

  // the feature state slot this wallet reads (seed-keyed, as loadFeatureState does)
  const key = cacheKeyFor(mnemonic + '\n') + ':messages';

  // the shape the chat paints from: remembered totals keyed by event id
  const painted = await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    s.zaps = { ['a'.repeat(64)]: { s: 2100, m: 1 }, ['b'.repeat(64)]: { s: 21 } };
    localStorage.setItem(k, JSON.stringify(s));
    return Object.keys(s.zaps).length;
  }, key);
  check('seeded two remembered tallies', painted === 2);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  // open the chat — the screen that rewrites this state, and where a stale
  // copy being saved back would quietly drop every remembered tally
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(2500);
  const kept = await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    return Object.keys(s.zaps || {}).length;
  }, key);
  check('they survive a refresh and a trip through chat', kept === 2, kept + ' kept');

  // and they are readable as tallies, not re-fetched from scratch: the
  // seeded totals are what a chip would paint before any relay answers
  const readable = await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    const v = s.zaps[Object.keys(s.zaps)[0]];
    return v && typeof v.s === 'number' && v.s > 0;
  }, key);
  check('a remembered tally carries its sats', readable);
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ tallies survive a refresh' : '\n❌ failed');
process.exit(ok ? 0 : 1);
