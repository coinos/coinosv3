// NIP-55: on Android, "Sign in with Amber" opens a nostrsigner: intent for the
// pubkey; the answer is read from the clipboard when the tab comes back (or
// pasted); creating the wallet then makes an encrypt and a sign round trip.
// The intent launcher and the clipboard are stubbed; relays answer nothing.
// Run: bun tools/amber-login-test.js
import puppeteer from 'puppeteer-core';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SK = generateSecretKey(); const PK = getPublicKey(SK);
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5308, fetch: (req) => { const p = new URL(req.url).pathname; if (p === '/verify-worker.js' || p.startsWith('/punks')) return new Response(Bun.file('dist' + p)); return new Response(html, { headers: { 'content-type': 'text/html' } }); } });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36');
await page.evaluateOnNewDocument(() => {
  window.__amberUrls = [];
  window.__coinosAmberLaunch = (u) => { window.__amberUrls.push(u); };
  window.__clip = '';
  Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => window.__clip, writeText: async () => {} }, configurable: true });
  const Real = window.WebSocket;
  window.WebSocket = function (...a) { const ws = new Real(...a); const send = ws.send.bind(ws); ws.send = (d) => { try { const m = JSON.parse(d); if (m[0] === 'REQ') { setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) })), 0); return; } if (m[0] === 'EVENT') { window.__published = (window.__published || []).concat([m[1]]); setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['OK', m[1].id, true, '']) })), 0); return; } } catch {} return send(d); }; return ws; };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const urls = () => page.evaluate(() => window.__amberUrls);
const lastType = async () => { const u = await urls(); const last = u[u.length - 1] || ''; return (last.match(/[?&]type=([a-z_0-9]+)/) || [])[1] || null; };
const deliver = (text) => page.evaluate((t) => { window.__clip = t; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); }, text);

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5308/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(500);
  console.log('\n[the Amber door]');
  check('the front door offers Nostr sign-in', await click('sign in with nostr') || await click('nostr'));
  await sleep(500);
  check('on Android, the login offers Amber', await waitText('sign in with amber', 5000));
  await click('sign in with amber'); await sleep(400);
  check('tapping it opens a get_public_key intent', (await lastType()) === 'get_public_key', JSON.stringify(await urls()));
  check('...and shows the waiting card with a paste box', await waitText('waiting for your signer', 2000) && !!(await page.$('.amber-paste')));
  await deliver(npubEncode(PK));
  // a fresh account: the wallet is minted and its backup goes to the app to be encrypted
  let t0 = Date.now(); while (Date.now() - t0 < 15000 && (await lastType()) !== 'nip44_encrypt') await sleep(250);
  check('the pubkey read off the clipboard signs the account in; the seed goes to the app for encryption', (await lastType()) === 'nip44_encrypt', JSON.stringify((await urls()).map((u) => (u.match(/[?&]type=([a-z_0-9]+)/) || [])[1])));
  check('...and the npub left on the clipboard is not mistaken for the ciphertext', await page.evaluate(() => !!document.querySelector('.amber-paste')));

  console.log('\n[creating the wallet: encrypt, then sign, each a round trip]');
  const encUrl = (await urls()).pop();
  check('...addressed to the user\'s own key', new URL(encUrl.replace('nostrsigner:', 'http://x/')).searchParams.get('pubkey') === PK);
  // this time the clipboard is not readable: the answer is pasted
  await page.evaluate(() => { navigator.clipboard.readText = async () => { throw new Error('denied'); }; });
  const fakeCipher = 'Ag' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(96)))).replace(/=+$/, '').replace(/[^A-Za-z0-9+/]/g, 'a');
  await page.type('.amber-paste', fakeCipher);
  await click('use it'); await sleep(800);
  check('the pasted ciphertext moves things on to a signature', (await lastType()) === 'sign_event', await lastType());
  const signUrl = (await urls()).pop();
  const unsigned = JSON.parse(decodeURIComponent(signUrl.slice('nostrsigner:'.length).split('?')[0]));
  check('...of an event under the signed-in pubkey', unsigned.pubkey === PK && typeof unsigned.kind === 'number', JSON.stringify({ kind: unsigned.kind, pk: unsigned.pubkey.slice(0, 8) }));
  const signed = finalizeEvent({ kind: unsigned.kind, created_at: unsigned.created_at, tags: unsigned.tags, content: unsigned.content }, SK);
  await page.evaluate(() => { navigator.clipboard.readText = async () => window.__clip; });
  await deliver(JSON.stringify(signed)); await sleep(2500);
  const pub = await page.evaluate(() => (window.__published || []).map((e) => e.kind));
  check('the signed backup is published and the new identity walks into onboarding', pub.includes(30078) && await waitText('write down your recovery phrase', 10000), 'published kinds ' + JSON.stringify(pub));
  // the rest of the first run: every further signature (relay list, follows)
  // is one more trip through Amber, taken in turn, while the words screen is
  // walked through
  const signedKinds = [];
  let signedUrls = 1;
  for (let i = 0; i < 80 && !(await page.evaluate(() => document.body.innerText.toLowerCase().includes('receive'))); i++) {
    const us = await urls();
    const pend = us.filter((u) => /type=sign_event/.test(u));
    if (pend.length > signedUrls) {
      const u = pend[signedUrls]; signedUrls++;
      const ev = JSON.parse(decodeURIComponent(u.slice('nostrsigner:'.length).split('?')[0]));
      signedKinds.push(ev.kind);
      await deliver(JSON.stringify(finalizeEvent({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content }, SK)));
    } else { await click('later') || await click('skip verification') || await click("i've written it down") || await click('continue'); }
    await sleep(500);
  }
  if (!(await page.evaluate(() => document.body.innerText.toLowerCase().includes('receive')))) console.log('  DEBUG loop end:', JSON.stringify(await page.evaluate(() => ({ btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12), text: document.body.innerText.slice(0, 160).replace(/\n+/g, ' | ') }))));
  check('each later signature (follows, relays) was its own trip, and the wallet opens on Receive', await waitText('receive', 5000) && signedKinds.length > 0, 'signed kinds after the backup ' + JSON.stringify(signedKinds));
  check('no request cancelled another', !(await page.evaluate(() => document.body.innerText)).includes('took its place'));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ Amber signs in and signs, one trip at a time' : '\n❌ failed');
process.exit(ok ? 0 : 1);
