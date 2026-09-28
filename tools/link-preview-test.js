// A plain link in a post becomes the card its page describes: the registrar
// is asked for the page's Open Graph data (shimmed here), the picture is
// warmed with the rest of the post, and the row paints whole. A page with
// nothing to say stays a bare link; pictures and YouTube keep their own
// boxes.
// Run: bun tools/link-preview-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const AUTHOR = generateSecretKey(); const APK = getPublicKey(AUTHOR);
const now = Math.floor(Date.now() / 1000);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const POSTS = [
  finalizeEvent({ kind: 1, created_at: now - 30, tags: [], content: 'Well, yeah https://news.example/story/1' }, AUTHOR),
  finalizeEvent({ kind: 1, created_at: now - 60, tags: [], content: 'nothing here https://blank.example/page' }, AUTHOR),
  finalizeEvent({ kind: 1, created_at: now - 90, tags: [], content: 'a picture http://localhost:5311/pic.png' }, AUTHOR),
];
const PROFILE = finalizeEvent({ kind: 0, created_at: now - 100, tags: [], content: JSON.stringify({ name: 'Linker', picture: 'http://localhost:5311/face.png' }) }, AUTHOR);

const html = await buildHtml({ minify: true, pwa: false });
const previewHits = [];
const server = Bun.serve({ port: 5311, fetch: (req) => {
  const u = new URL(req.url);
  if (u.pathname === '/preview') {
    const target = u.searchParams.get('url'); previewHits.push(target);
    const meta = target === 'https://news.example/story/1'
      ? { url: target, title: 'Lawmakers doubt the plan', description: 'A story in one line.', image: 'http://localhost:5311/card.png', site: 'News Example' }
      : {};
    return new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  }
  if (u.pathname.endsWith('.png')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  if (u.pathname.startsWith('/punks') || u.pathname === '/verify-worker.js') return new Response(Bun.file('dist' + u.pathname));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((posts, profile) => {
  // the registrar's preview endpoint answers from this test's server
  const realFetch = window.fetch;
  window.fetch = (u, o) => realFetch(String(u).startsWith('https://names.coinos.io/preview') ? String(u).replace('https://names.coinos.io', 'http://localhost:5311') : u, o);
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ') {
          const f = m[2] || {};
          let evs = [];
          if ((f.kinds || []).includes(1) && (f.authors || []).includes(profile.pubkey)) evs = posts;
          if ((f.kinds || []).includes(0) && (f.authors || []).includes(profile.pubkey)) evs = [profile];
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
}, POSTS, PROFILE);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5311/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  // follow the author, so the feed asks for their posts
  await page.evaluate(([k, pk]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Linker', t: Date.now() } }));
  }, [base, APK]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(500);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await page.waitForSelector('.notes-feed:not([data-booting]) > .row', { timeout: 30000 });
  await sleep(800);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.notes-feed > .row')].map((r) => ({
    text: r.textContent.trim().slice(0, 60),
    card: !!r.querySelector('.link-card'),
    title: r.querySelector('.link-title')?.textContent,
    thumb: r.querySelector('.link-thumb')?.getAttribute('src') || r.querySelector('.link-thumb')?.dataset.lazySrc,
    thumbShown: (() => { const i = r.querySelector('.link-thumb'); return !!i && i.complete && i.naturalWidth > 0; })(),
    bareLink: !!r.querySelector('a[href^="https://blank.example"]'),
    img: !!r.querySelector('img.note-img'),
  })));
  const story = rows.find((r) => /well, yeah/i.test(r.text));
  const blank = rows.find((r) => /nothing here/i.test(r.text));
  const pic = rows.find((r) => /a picture/i.test(r.text));
  check('a post with a link paints its card', !!story && story.card, JSON.stringify(story));
  check('...with the page\'s title', story?.title === 'Lawmakers doubt the plan', story?.title);
  check('...and its picture, already decoded', !!story?.thumb && story.thumbShown, JSON.stringify({ thumb: story?.thumb, shown: story?.thumbShown }));
  check('a page with nothing to show stays a bare link', !!blank && blank.bareLink && !blank.card, JSON.stringify(blank));
  check('a picture link is still a picture, not a card', !!pic && pic.img && !pic.card, JSON.stringify(pic));
  check('the registrar was asked once per link', previewHits.filter((u) => u === 'https://news.example/story/1').length === 1 && !previewHits.some((u) => u.endsWith('.png')), JSON.stringify(previewHits));
  let kept = 0; // written behind, a second after the card was learned
  for (let i = 0; i < 12 && !kept; i++) { kept = await page.evaluate(() => JSON.parse(localStorage.getItem('coinos-link-previews') || '[]').length); if (!kept) await sleep(300); }
  check('the card is remembered for next time', kept === 1, kept + ' kept');
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ links show as the cards their pages describe' : '\n❌ failed');
process.exit(ok ? 0 : 1);
