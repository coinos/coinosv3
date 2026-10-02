// The feed you were on is remembered per wallet: a new account starts on
// Popular, not on whatever the last account on this device was reading.
// Run: bun tools/feed-choice-per-wallet-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.evaluateOnNewDocument(() => {
  // no relays: chips and selection are all this test is about
  const Real = window.WebSocket;
  window.WebSocket = function (...a) { const ws = new Real(...a); ws.send = (d) => { try { const m = JSON.parse(d); if (m[0] === 'REQ') setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) })), 0); } catch {} }; return ws; };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitFor = async (fn, ms = 20000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
const activeChip = () => page.evaluate(() => document.querySelector('.feed-chip.on')?.textContent.trim() || null);
const openWallet = async (mn) => {
  await click('create a new wallet'); await sleep(500); await click('to import'); await sleep(400);
  await page.waitForSelector('textarea'); await page.type('textarea', mn); await click('open wallet');
  await waitFor(() => !!document.querySelector('[aria-label="Feed"]'));
};
const openFeed = async () => { await page.click('[aria-label="Feed"]'); await waitFor(() => !!document.querySelector('.feed-chip.on'), 10000); await sleep(400); };
const logout = async () => {
  await page.evaluate(() => document.querySelector('.header-avatar')?.click()); await sleep(800);
  await click('log out'); await sleep(400);
  await page.evaluate(() => document.querySelector('.confirm-pop .btn-primary')?.click()); await sleep(800);
  await click('not now'); await sleep(800); // the password offer on the way out
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /log out|get started|create a new wallet/i.test(b.textContent))); 
};
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('btc-wallet-network', 'regtest'); localStorage.setItem('btc-wallet-feed', 'following'); });
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);

  const A = generateMnemonic(wordlist), B = generateMnemonic(wordlist);
  await openWallet(A);
  await openFeed();
  check('a new wallet opens the feed on Popular (an old device-wide choice is ignored)', await activeChip() === 'Popular', await activeChip());
  await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'Following')?.click()); await sleep(600);
  check('wallet A switches to Following', await activeChip() === 'Following', await activeChip());

  // logged out with no password: the saved-wallets list; a new one from there
  await logout();
  await click('sign into another account'); await sleep(600);
  // this screen has tabs, not the front page's buttons
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Import existing')?.click()); await sleep(400);
  await page.waitForSelector('textarea'); await page.type('textarea', B); await click('open wallet');
  await waitFor(() => !!document.querySelector('[aria-label="Feed"]'));
  await openFeed();
  check('a different new wallet starts on Popular, not on A’s Following', await activeChip() === 'Popular', await activeChip());

  // and back to A, from the saved-wallets list (A is the first one saved)
  await logout();
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^[●○] Savings/.test(b.textContent.trim()))?.click());
  await waitFor(() => !!document.querySelector('[aria-label="Feed"]'));
  await openFeed();
  check('A comes back to its own Following', await activeChip() === 'Following', await activeChip());
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  check('run completed', false, e.stack);
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ each wallet keeps its own feed; new ones start on Popular' : '\n❌ failures above');
process.exit(ok ? 0 : 1);
