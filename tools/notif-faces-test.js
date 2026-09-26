// Notifications: the list is cached locally, and the faces it will paint are
// fetched and decoded from the chat home — before the page is opened — so it
// opens with faces, not circles filling in. The stub relay answers the kind-0
// batch for the actors with pictures served by this test.
// Run: bun tools/notif-faces-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const ACTORS = Array.from({ length: 5 }, () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; });
const now = Math.floor(Date.now() / 1000);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PROFILES = ACTORS.map((a, i) => finalizeEvent({ kind: 0, created_at: now - 100, tags: [], content: JSON.stringify({ name: 'Actor ' + i, picture: 'http://localhost:5306/face-' + i + '.png' }) }, a.sk));

const html = await buildHtml({ minify: true, pwa: false });
const faceHits = [];
const server = Bun.serve({ port: 5306, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/face-')) { faceHits.push(path); return new Response(PNG, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600' } }); }
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((profiles) => {
  window.__profileReqs = 0;
  const byPk = new Map(profiles.map((p) => [p.pubkey, p]));
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          const evs = (f.kinds || []).includes(0) ? (f.authors || []).map((pk) => byPk.get(pk)).filter(Boolean) : [];
          if (evs.length) { window.__profileReqs++; (window.__log ||= []).push([f.authors.length, evs.length, a[0]]); }
          setTimeout(() => {
            for (const e of evs) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], e]) }));
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
          }, 0);
          return;
        }
        if (m[0] === 'EVENT') return;
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
}, PROFILES);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5306/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  const ME = getPublicKey(privateKeyFromSeedWords(mn));
  // a cached notifications list: five people reacted to my post
  const items = ACTORS.map((a, i) => ({ id: 'r'.repeat(63) + i, what: 'react', actor: a.pk, target: 't'.repeat(64), hint: [], emoji: '❤️', ts: now - 60 * (i + 1) }));
  await page.evaluate(([k, me, items]) => {
    const st = JSON.parse(localStorage.getItem(k + ':messages') || '{}');
    st.notifs = items; st.notifsPk = me;
    localStorage.setItem(k + ':messages', JSON.stringify(st));
  }, [base, ME, items]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(3000);
  console.log('\n[on the chat home, before opening Notifications]');
  check('the cached list is there (the row counts it)', await page.evaluate(() => !!document.querySelector('.notifs-row, .chat-thread-row') && /Notifications/.test(document.body.innerText)));
  check('the actors\' profiles were asked for', (await page.evaluate(() => window.__profileReqs)) > 0);
  check('...and their pictures fetched', faceHits.length >= 5, faceHits.length + ' of 5');
  const profs = await page.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k + ':profiles') || '{}')).length, base);
  check('...and remembered in the profile cache', profs >= 5, profs + ' profiles');

  console.log('\n[opening the page]');
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /Notifications/.test(n.textContent)); if (e) e.click(); });
  await sleep(150); // the first paint, not a settled one
  const faces = await page.evaluate(() => [...document.querySelectorAll('.notes-feed .chat-avatar')].map((a) => a.classList.contains('ava-img') || (a.style.backgroundImage || '').includes('url')));
  check('every row paints with a face on the first frame', faces.length >= 5 && faces.every(Boolean), JSON.stringify(faces));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ notifications open with their faces on' : '\n❌ failed');
process.exit(ok ? 0 : 1);
