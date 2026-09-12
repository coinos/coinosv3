// A phone with no push service — GrapheneOS, or any de-Googled Android —
// can't be woken while the app is closed, because Chromium routes web push
// through Firebase. The browser reports that as "Registration failed - push
// service error", which tells nobody anything. The app has to say what's
// actually wrong and what works instead.
//
// Run: bun tools/push-unavailable-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5262, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  const reg = {
    pushManager: {
      getSubscription: () => Promise.resolve(null),
      // exactly what Chrome throws with no Firebase behind it
      subscribe: () => Promise.reject(new DOMException('Registration failed - push service error', 'AbortError')),
    },
    showNotification: () => Promise.resolve(),
  };
  Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
  Notification.requestPermission = () => Promise.resolve('granted');
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5262/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
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

  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(2500);
  const txt = await page.evaluate(() => document.body.innerText);
  check('the chat says why it can\'t be woken', /no push service/i.test(txt), (txt.match(/[^\n]*push service[^\n]*/i) || ['nothing'])[0].slice(0, 60));
  check('...and names what does work', /Firefox/.test(txt) && /Google Play Services/.test(txt));
  check('...and says zaps still work with the app open', /whenever coinos is open/i.test(txt));
  const flag = await page.evaluate((k) => (JSON.parse(localStorage.getItem(k + ':messages') || '{}')).noPushService === true, base);
  check('the failure is remembered, so it isn\'t retried on a loop', flag);

  // the same explanation where the zap-answering toggle lives
  await page.evaluate((k) => localStorage.setItem(k + ':nwc', JSON.stringify({
    conns: [{ id: 'x', name: 'test', servicePk: 'a'.repeat(64), sk: 'b'.repeat(64), maxSat: 1000, budget: {} }],
    pushUnavailable: true,
  })), base);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /settings/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(700);
  await click('nostr'); await sleep(1200);
  const settings = await page.evaluate(() => document.body.innerText);
  check('the "answer while closed" toggle explains itself too',
    /no push service/i.test(settings), (settings.match(/[^\n]*push service[^\n]*/i) || ['nothing'])[0].slice(0, 50));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ a phone without push is told why' : '\n❌ failed');
process.exit(ok ? 0 : 1);
