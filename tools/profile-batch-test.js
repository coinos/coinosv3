// A feed paints eighty rows at once, and each row wants a face. Asked one
// pubkey per REQ, relays cap the concurrency, most are refused, and the rows
// settle as a punk and a shortened npub — which is what a real feed looked
// like. They go out in batches now, so the whole screen is one request.
//
// This counts the REQs the app actually sends for kind 0, against real
// relays and real pubkeys from that feed.
//
// Run: bun tools/profile-batch-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

// thirty people who really post, so the feed has thirty faces to find
const pool = new SimplePool();
const seeds = ['3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2',
  '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9'];
const recent = await pool.querySync(['wss://relay.primal.net', 'wss://nos.lol'],
  { kinds: [1], limit: 120, since: Math.floor(Date.now() / 1000) - 3600 }, { maxWait: 8000 }).catch(() => []);
const authors = [...new Set([...seeds, ...recent.map((e) => e.pubkey)])].slice(0, 30);
const notes = recent.filter((e) => authors.includes(e.pubkey)).slice(0, 30);
if (notes.length < 10) { console.log(' ✗ relays too quiet to test with'); process.exit(1); }

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5273, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/profiles asked/.test(t)) console.log('   [page]', t); });
// count the kind-0 requests the app sends, and how many pubkeys each carries
await page.evaluateOnNewDocument(() => {
  window.__k0 = [];
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2] && Array.isArray(m[2].kinds) && m[2].kinds.includes(0)) {
          const a = m[2].authors || [];
          window.__k0.push(a.length);
          // the same fetch goes to every relay, so count distinct ASKS (by
          // what was asked for) rather than sockets written to
          window.__k0asks = window.__k0asks || new Set();
          window.__k0asks.add(a.join(','));
        }
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5273/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  const mn = generateMnemonic(wordlist);
  await page.type('textarea', mn);
  await click('open wallet');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pks, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: pks.map((p) => ['p', p]), c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [base, authors, notes.map((e) => ({ id: e.id, pubkey: e.pubkey, kind: 1, created_at: e.created_at, content: e.content.slice(0, 200), tags: [] }))]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(12000);

  const reqs = await page.evaluate(() => window.__k0);
  const rowCount = await page.evaluate(() => document.querySelectorAll('.notes-feed > .row').length);
  // A screenful of faces must cost a handful of asks, not one per row. (A few
  // singles are expected and fine: our own profile, which onboarding reads
  // before it writes a name, and the outbox fallback chasing one straggler to
  // the relay only they publish to.)
  const asks = await page.evaluate(() => [...(window.__k0asks || [])].length);
  check('a screenful of faces costs a handful of asks, not one per row',
    reqs.length > 0 && asks <= Math.max(4, rowCount / 4),
    `${asks} asks for ${rowCount} rows, batches of ${[...new Set(reqs)].filter((n) => n > 1).join(',')}`);
  check('...one request covers the screen', Math.max(0, ...reqs) >= 8, 'biggest carried ' + Math.max(0, ...reqs) + ' pubkeys');

  // The honest measure, and the exact complaint: a row wearing a punk and a
  // shortened npub. For each of those, ask the relays directly whether that
  // person has ever published a name. If nobody has, the rows are telling the
  // truth — plenty of posters have no profile at all, and that isn't ours to
  // fix. Any row whose person DOES have a kind 0 is a face we failed to fetch.
  const shown = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.notes-feed > .row')];
    return rows.map((r) => {
      const n = r.querySelector('.col > .row span');
      const t = n ? n.textContent.trim() : '';
      return { name: t, npub: /^npub1/.test(t) ? t : null };
    });
  });
  const anon = [...new Set(shown.map((r) => r.npub).filter(Boolean))];
  // the row shows a truncated npub, so match it back to the people we seeded
  const nameless = [];
  for (const short of anon) {
    const pk = [...new Set(notes.map((e) => e.pubkey))].find((p) => nip19.npubEncode(p).startsWith(short));
    if (pk) nameless.push(pk);
  }
  const reallyNamed = new Set();
  if (nameless.length) {
    for (const e of await pool.querySync(['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://purplepag.es'],
      { kinds: [0], authors: nameless }, { maxWait: 8000 }).catch(() => [])) {
      try { const m = JSON.parse(e.content); if (m.display_name || m.name) reallyNamed.add(e.pubkey); } catch {}
    }
  }
  const named = shown.filter((r) => !r.npub).length;
  check('nobody is shown as an npub who has published a name',
    reallyNamed.size === 0,
    `${named} of ${shown.length} rows named; of the ${nameless.length} shown as an npub, ${reallyNamed.size} have a kind 0 we missed`);
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the feed knows who it is showing' : '\n❌ failed');
process.exit(ok ? 0 : 1);
