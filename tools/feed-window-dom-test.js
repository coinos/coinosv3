// Windowing: however far you scroll, only the rows near the viewport are in
// the DOM — a spacer stands in for the rest at their measured height, so the
// page keeps its length, the row under your eyes never moves when the window
// shifts, and scrolling back up brings the top posts back.
// Run: bun tools/feed-window-dom-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const now = Math.floor(Date.now() / 1000);
// 120 cached posts of wildly different heights
const seeded = Array.from({ length: 120 }, (_, i) => finalizeEvent({
  kind: 1, created_at: now - 100 - i * 60, tags: [],
  content: 'post number ' + (i + 1) + ' ' + (i % 3 === 0 ? 'short' : i % 3 === 1 ? 'a medium length post about nothing in particular, '.repeat(3) : 'a long one. '.repeat(30)),
}, SK));

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5305, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/punks')) return new Response(Bun.file('dist' + path));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// the stub relay holds every post: a kind-1 request is answered from it
// (honouring until/limit), everything else gets a bare EOSE
await page.evaluateOnNewDocument((all) => {
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          const evs = (f.kinds || []).includes(1) && !f['#e'] && !f.ids
            ? all.filter((e) => (!f.until || e.created_at <= f.until) && (!f.since || e.created_at >= f.since)).slice(0, f.limit || 100) : [];
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
}, seeded);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const dom = () => page.evaluate(() => ({
  rows: document.querySelectorAll('.notes-feed > .row[data-key]').length,
  top: document.querySelector('.notes-feed > [data-key="win-top"]')?.offsetHeight || 0,
  bottom: document.querySelector('.notes-feed > [data-key="win-bottom"]')?.offsetHeight || 0,
  height: document.documentElement.scrollHeight, y: window.scrollY,
  first: document.querySelector('.notes-feed > .row[data-key]')?.innerText.match(/post number \d+/)?.[0],
}));
const anchor = () => page.evaluate(() => {
  const r = [...document.querySelectorAll('.notes-feed > .row[data-key]')].find((n) => { const b = n.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; });
  return r ? { id: r.dataset.key, top: Math.round(r.getBoundingClientRect().top) } : null;
});

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5305/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Prolific Poster', t: Date.now() } }));
  }, [base, AUTHOR, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); }); await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'Feed'); if (e) e.click(); });
  await sleep(2500);
  console.log('\n[a long scroll]');
  check('the feed opens on its first posts', (await dom()).first === 'post number 1', JSON.stringify(await dom()));
  // page to the bottom, again and again
  let d = null;
  for (let i = 0; i < 14; i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(700);
    d = await dom();
  }
  check('many pages in, the page is long', d.height > 6000, d.height + 'px');
  check('...but only a window of rows is mounted', d.rows > 0 && d.rows <= 60, d.rows + ' rows');
  check('...with a spacer standing in for the rows above', d.top > 1000, d.top + 'px');

  console.log('\n[the row under your eyes stays put]');
  await page.evaluate(() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.5))); await sleep(600);
  const a1 = await anchor();
  // the window moves as you read; a beat later, nothing under the eyes has shifted
  await page.evaluate(() => window.scrollBy(0, 300)); await sleep(400);
  await page.evaluate(() => window.scrollBy(0, -300)); await sleep(600);
  const a2 = await anchor();
  check('scrolling around and back leaves the same row at the same place', !!a1 && !!a2 && a1.id === a2.id && Math.abs(a1.top - a2.top) <= 2, JSON.stringify({ a1, a2 }));
  const mid = await dom();
  check('mid-feed, spacers stand in above and below', mid.top > 500 && mid.bottom > 500 && mid.rows <= 60, JSON.stringify(mid));

  console.log('\n[back to the top]');
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(800);
  const t = await dom();
  check('the first posts are back in the DOM', t.first === 'post number 1' && t.top === 0, JSON.stringify(t));
  check('...and the rows below are held by a spacer', t.bottom > 1000 && t.rows <= 60, JSON.stringify(t));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the feed stays light however far you scroll' : '\n❌ failed');
process.exit(ok ? 0 : 1);
