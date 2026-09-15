// A relay socket that dies while the app is on screen must not leave the
// room deaf. Every relay socket under an open coinos room is made to ERROR
// (what a wifi hop or a phone freezing the tab does): nostr-tools drops an
// errored relay from its pool with every subscription it carried and never
// dials it again, so it's the watchdog's job to notice and rebuild — with no
// 'online' event and no resume hook to lean on. Afterwards the rebuilt
// subscriptions must stay quiet (no further rebuilds) and the sockets open.
//
// Chrome's offline emulation leaves established sockets alone, so the
// sockets are reached through a registry shimmed onto window.WebSocket.
//
// Run: bun tools/chat-watchdog-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5232, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// every socket the page opens, so the test can kill them the way the OS does
await page.evaluateOnNewDocument(() => {
  const Real = window.WebSocket;
  const live = new Set();
  window.__sockets = live;
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      const ws = new target(...args);
      live.add(ws);
      ws.addEventListener('close', () => live.delete(ws));
      return ws;
    },
  });
});
const warns = [];
page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'warning') warns.push({ t: Date.now(), text: m.text() }); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };
const rebuilds = (since = 0) => warns.filter((w) => w.t >= since && /resubscribing/.test(w.text));
const waitRebuild = async (since, ms) => { for (let i = 0; i < ms / 500; i++) { if (rebuilds(since).length) return true; await sleep(500); } return false; };

try {
  await page.setViewport({ width: 420, height: 860 });
  await page.goto('http://localhost:5232/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('button', 'Create a new wallet'); await sleep(300);
  await click('button', 'Import existing'); await sleep(300);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  await waitText('receive', 15000);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /message/i.test(b.getAttribute('aria-label') || ''))?.click());
  await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.chat-thread-row')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'coinos'); if (e) e.click(); });
  check('the coinos room opens with messages', await waitText('GM Coinos community', 30000));
  await sleep(12000); // a full watchdog tick with everything healthy
  check('a healthy room triggers no rebuild', rebuilds().length === 0, rebuilds().map((w) => w.text).join(' | ').slice(0, 200) || 'none');

  console.log('\n[every relay socket errors under the open room]');
  const before = await page.evaluate(() => [...window.__sockets].filter((w) => w.readyState === 1).map((w) => w.url));
  check('relay sockets are open to begin with', before.length >= 2, before.join(' '));
  const cut = Date.now();
  await page.evaluate(() => {
    for (const ws of [...window.__sockets]) {
      // the handler nostr-tools installed: an error drops the relay from
      // the pool and closes its subscriptions for good
      try { ws.onerror && ws.onerror(new Event('error')); } catch {}
      try { ws.close(); } catch {}
    }
  });
  check('the watchdog notices and rebuilds within seconds', await waitRebuild(cut, 15000),
    rebuilds(cut).map((w) => w.text).join(' | ').slice(0, 200));
  await sleep(6000);
  const after = await page.evaluate(() => [...window.__sockets].filter((w) => w.readyState === 1).map((w) => w.url));
  check('the relays are dialed again', after.length >= 2, after.join(' '));

  console.log('\n[and then it stays quiet]');
  const settled = Date.now();
  await sleep(25000);
  const late = rebuilds(settled);
  check('the rebuilt subscriptions stay up (no further rebuilds)', late.length === 0, late.map((w) => w.text).join(' | ').slice(0, 200));
  const fresh = await page.evaluate(() => document.querySelectorAll('.chat-bubble').length);
  check('the room still shows its messages', fresh > 5, `${fresh} bubbles`);
} catch (e) { console.log('ERROR', e); ok = false; }
await browser.close();
server.stop(true);
console.log(ok ? '\nALL GOOD' : '\nFAILURES');
process.exit(ok ? 0 : 1);
