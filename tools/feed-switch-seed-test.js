// Switching to a feed paints posts at once, never a bare spinner, even when
// the relays are slow: a feed that was never opened borrows matching posts
// other open feeds already hold, and once the feed on screen settles the
// other feeds' first posts are fetched ahead into the disk cache.
// Run: bun tools/feed-switch-seed-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const A = generateSecretKey(), B = generateSecretKey();
const PK_A = getPublicKey(A), PK_B = getPublicKey(B);
const now = Math.floor(Date.now() / 1000);
const post = (sk, i, content, tags = []) => finalizeEvent({ kind: 1, created_at: now - 100 - i * 60, tags, content }, sk);
// Alice is followed; one of her posts is on #bitcoin. Bob is only in his own feed.
const alice = Array.from({ length: 12 }, (_, i) => post(A, i, 'alice post ' + (i + 1), i === 3 ? [['t', 'bitcoin']] : []));
const bob = Array.from({ length: 12 }, (_, i) => post(B, i, 'bob post ' + (i + 1)));

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// Stub relay: kind-1 requests answered from the posts above, by author and
// (for topics) never — until window.__slow, when every answer takes 8 s.
await page.evaluateOnNewDocument((all) => {
  const Real = window.WebSocket;
  window.__reqs = [];
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          const evs = (f.kinds || []).includes(1) && !f['#e'] && !f.ids && !f['#t'] && f.authors
            ? all.filter((e) => f.authors.includes(e.pubkey) && (!f.until || e.created_at <= f.until)).slice(0, f.limit || 100) : [];
          if (f.authors) window.__reqs.push({ authors: f.authors, limit: f.limit, slow: !!window.__slow });
          setTimeout(() => {
            for (const e of evs) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], e]) }));
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
          }, window.__slow ? 8000 : 0);
          return;
        }
        if (m[0] === 'EVENT') return;
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
}, [...alice, ...bob]);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const chip = (name) => page.evaluate((n) => { const e = [...document.querySelectorAll('.feed-chip')].find((b) => b.textContent.trim() === n); if (e) e.click(); return !!e; }, name);
const rows = () => page.evaluate(() => [...document.querySelectorAll('.notes-feed > .row[data-key]')].map((r) => r.innerText.match(/(alice|bob) post \d+/)?.[0]).filter(Boolean));
const spinner = () => page.evaluate(() => !document.querySelector('.notes-feed') && !!document.querySelector('.spinner'));

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, a, b, ns]) => {
    const t = Date.now();
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', a]], c: '', at: Math.floor(t / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [a]: { name: 'Alice', t }, [b]: { name: 'Bob', t } }));
    const s = JSON.parse(localStorage.getItem(k + ':messages') || '{}');
    s.feeds = [{ id: 'bob', name: 'Bobfeed', follows: false, authors: [b], topics: [], packs: [] },
      { id: 'btc', name: 'Btcfeed', follows: false, authors: [], topics: ['bitcoin'], packs: [] }];
    localStorage.setItem(k + ':messages', JSON.stringify(s));
    localStorage.setItem('btc-wallet-feed:' + k, 'following'); // this wallet's last feed
  }, [base, PK_A, PK_B, alice]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.app-nav-button, button')].find((b) => b.textContent.trim() === 'Feed')?.click());
  await page.waitForSelector('.notes-feed', { timeout: 15000 });
  check('Following opens on its cached posts', (await rows())[0] === 'alice post 1', JSON.stringify((await rows()).slice(0, 2)));

  // the feed on screen settles, then Bob's feed is fetched ahead
  let seeded = null;
  for (let i = 0; i < 40 && !seeded; i++) {
    await sleep(250);
    seeded = await page.evaluate((k) => JSON.parse(localStorage.getItem(k + ':feedNotes:bob') || 'null'), base);
  }
  check('another feed is fetched ahead into the disk cache', seeded?.seed && seeded.notes.length > 0 && seeded.notes.length <= 5,
    JSON.stringify(seeded && { seed: seeded.seed, n: seeded.notes.length }));
  check('...with a small request', (await page.evaluate(() => window.__reqs)).some((r) => r.authors.join() === PK_B && r.limit <= 10));

  // from here every relay answer takes 8 s
  await page.evaluate(() => { window.__slow = true; });
  check('the Bob chip is there', await chip('Bobfeed'));
  await sleep(400);
  const bobRows = await rows();
  check('switching to a feed fetched ahead paints its posts at once', bobRows[0] === 'bob post 1', JSON.stringify(bobRows.slice(0, 3)));
  check('...not a spinner', !(await spinner()));

  await chip('Btcfeed');
  await sleep(400);
  const btcRows = await rows();
  check('a topic feed never opened borrows a matching post an open feed holds', btcRows.includes('alice post 4') && btcRows.length === 1, JSON.stringify(btcRows));
  check('...not a spinner', !(await spinner()));
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  console.log('✗ threw', e.message); ok = false;
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ feed switching paints at once' : '\n❌ failed');
process.exit(ok ? 0 : 1);
