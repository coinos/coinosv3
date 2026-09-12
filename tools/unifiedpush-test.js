// UnifiedPush: the way a phone without Google Play Services can be reached.
//
// The Android wrapper asks a distributor (ntfy and friends) for an endpoint
// and hands it to the web app on the launch URL as ?up=. The web app is what
// knows which pubkeys to watch, so it does the registering; the notifier then
// POSTs payloads straight to that endpoint instead of through Firebase.
//
// This checks the web half: the endpoint is picked up, kept, registered with
// the notifier, and used in place of a browser subscription that could never
// have worked on such a phone.
//
// Run: bun tools/unifiedpush-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5263, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// a phone with no push service at all, which is the whole point of the exercise
await page.evaluateOnNewDocument(() => {
  const reg = {
    pushManager: {
      getSubscription: () => Promise.resolve(null),
      subscribe: () => Promise.reject(new DOMException('Registration failed - push service error', 'AbortError')),
    },
    showNotification: () => Promise.resolve(),
  };
  Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
  Notification.requestPermission = () => Promise.resolve('granted');
  Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
});
// watch what it tries to tell the notifier
const registrations = [];
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('nwcpush.coinos.io/register') && r.method() === 'POST') {
    try { registrations.push(JSON.parse(r.postData() || '{}')); } catch {}
    return r.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  if (r.url().includes('nwcpush.coinos.io/vapid')) return r.respond({ status: 200, contentType: 'application/json', body: '{"publicKey":"BKd0FOtD3Y9gAB3ZFDkCPlBtm0IhEbiKUeYUCE7Tuh9nWDOAhBKiZ0dPYjYQkHhVYyPNPUn0E-gLRPPqzYyAWmA"}' });
  return r.continue();
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const ENDPOINT = 'https://ntfy.sh/upTESTendpoint123';
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5263/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('get started'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('open wallet');
  await waitText('receive', 20000);

  // the wrapper launches the web app with the endpoint on the URL
  await page.goto('http://localhost:5263/?up=' + encodeURIComponent(ENDPOINT), { waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await sleep(2500);

  const kept = await page.evaluate(() => localStorage.getItem('coinos-unifiedpush'));
  check('the endpoint is taken off the launch URL and kept', kept === ENDPOINT, kept || 'nothing stored');
  check('...and the URL is tidied afterwards', !(await page.url()).includes('up='), await page.url());

  const up = registrations.find((r) => r.subscription && r.subscription.unifiedpush);
  check('the notifier is told to use it', !!up, JSON.stringify(registrations.map((r) => Object.keys(r))) || 'no registration');
  check('...with the endpoint, marked as UnifiedPush', up && up.subscription.endpoint === ENDPOINT, up ? up.subscription.endpoint : '');
  check('...and the watch list rides along', !!(up && up.notify), up ? Object.keys(up.notify || {}).join(',') : '');

  const txt = await page.evaluate(() => document.body.innerText);
  check('the browser\'s own dead push is no longer the story', !/no push service/i.test(txt),
    (txt.match(/[^\n]*push service[^\n]*/i) || [''])[0].slice(0, 50));

  // The WebView build wakes the wallet off-screen with ?wake=<payload> and a
  // CoinosHost bridge. The page has to notice, tidy the URL, and say when
  // it's finished so the service can stop.
  await page.evaluateOnNewDocument(() => {
    window.__done = 0;
    window.CoinosHost = { done: () => { window.__done++; }, notify: () => {} };
  });
  await page.goto('http://localhost:5263/?wake=' + encodeURIComponent(JSON.stringify({ type: 'nwc', servicePubkey: 'a'.repeat(64) })), { waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  check('a woken run takes the payload off the URL', !(await page.url()).includes('wake='), await page.url());
  await sleep(8000); // a wallet with no connections has nothing to wait for
  const done = await page.evaluate(() => window.__done);
  check('...and tells the service when to stop', done > 0, done + ' call(s) to CoinosHost.done()');
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ a de-Googled phone can be reached' : '\n❌ failed');
process.exit(ok ? 0 : 1);
