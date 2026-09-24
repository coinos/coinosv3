// Offline browser regression: cached rows must arrive whole and stay still.
// Run: bun tools/feed-stability-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { noteEncode, npubEncode } from 'nostr-tools/nip19';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!condition) ok = false;
};
const sk = generateSecretKey(), pk = getPublicKey(sk);
const otherKey = generateSecretKey(), other = getPublicKey(otherKey);
const now = Math.floor(Date.now() / 1000);
const event = (content, at, key = sk, kind = 1) => finalizeEvent({ kind, content, created_at: at, tags: [] }, key);
const origin = 'http://localhost:5298';
const quote = event('Quoted content ' + origin + '/quote.png', now - 2000, otherKey);
const profile = event(JSON.stringify({ name: 'Mentioned Person', picture: origin + '/quote-avatar.png' }), now, otherKey, 0);
const seeded = Array.from({ length: 45 }, (_, i) => event('Cached post ' + i + '\nEnough text to make each post a comfortable reading target.', now - 600 - i * 60));
seeded[1] = event('With a quote nostr:' + noteEncode(quote.id) + ' and @' + npubEncode(other), now - 660);
seeded[3] = event('Unavailable picture ' + origin + '/late.png', now - 780);
seeded[8] = event('Five pictures ' + Array.from({ length: 5 }, (_, i) => origin + '/gallery' + i + '.png').join(' '), now - 1080);
seeded[24] = event('Next page picture ' + origin + '/next.png', now - 2040);
const requested = new Map();
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5298, fetch: async (req) => {
  const path = new URL(req.url).pathname;
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
  if (path.startsWith('/punks')) return new Response(Bun.file('dist' + path));
  requested.set(path, (requested.get(path) || 0) + 1);
  const delay = path === '/avatar.png' ? 3000 : path === '/gallery4.png' || path === '/next.png' ? 3500 : path === '/late.png' ? 10000 : 150;
  await sleep(delay);
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="teal"/></svg>', {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' },
  });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.setViewport({ width: 390, height: 844 });
await page.evaluateOnNewDocument((fixtures) => {
  const sockets = [];
  class FakeSocket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0; this.subs = new Map(); sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.emit('open', new Event('open')); }, 0);
    }
    emit(type, ev) { this.dispatchEvent(ev); this['on' + type]?.(ev); }
    message(data) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(data) })); }
    send(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m[0] === 'CLOSE') { this.subs.delete(m[1]); return; }
      if (m[0] !== 'REQ') return;
      const [_, id, filter] = m;
      this.subs.set(id, filter);
      let events = [];
      if (filter.kinds?.includes(0) && filter.authors?.includes(fixtures.profile.pubkey)) events = [fixtures.profile];
      if (filter.ids?.includes(fixtures.quote.id)) events = [fixtures.quote];
      if (filter.kinds?.includes(1) && !filter.since && !filter.until) events = window.__catchup || [];
      setTimeout(() => {
        if (!this.subs.has(id)) return;
        for (const e of events) this.message(['EVENT', id, e]);
        this.message(['EOSE', id]);
      }, events.length ? 700 : 20);
    }
    close() { this.readyState = 3; this.emit('close', new Event('close')); }
  }
  Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = FakeSocket;
  window.__inject = (e) => {
    let count = 0;
    for (const ws of sockets) for (const [id, f] of ws.subs) {
      if (ws.readyState === 1 && f.kinds?.includes(1) && f.since) { ws.message(['EVENT', id, e]); count++; }
    }
    return count;
  };
}, { profile, quote });
const click = (text) => page.evaluate((text) => [...document.querySelectorAll('button')].find((e) => e.textContent.toLowerCase().includes(text))?.click(), text);
const row = (id) => `.notes-feed > [data-key="${id}"]`;
const snapshot = () => page.evaluate(() => [...document.querySelectorAll('.notes-feed > [data-zap-post]')].map((n) => {
  const b = n.getBoundingClientRect();
  return { id: n.dataset.key, top: b.top, height: b.height, text: n.innerText, avatar: n.querySelector('.note-avatar')?.getAttribute('style') };
}));
try {
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload(); await sleep(300);
  await click('create a new wallet'); await sleep(400);
  await click('to import');
  await page.waitForSelector('textarea');
  const mnemonic = generateMnemonic(wordlist);
  await page.type('textarea', mnemonic);
  await click('open wallet');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('receive'));
  const base = cacheKeyFor(mnemonic + '\n');
  await page.evaluate(([base, pk, seeded, origin]) => {
    localStorage.setItem(base + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(base + ':feedNotes', JSON.stringify(seeded));
    localStorage.setItem(base + ':profiles', JSON.stringify({ [pk]: { name: 'Cached Author', picture: origin + '/avatar.png', t: Date.now() } }));
  }, [base, pk, seeded, origin]);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('receive'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || ''))?.click());
  await page.waitForSelector('.item');
  await page.evaluate(() => [...document.querySelectorAll('.item')].find((e) => /feed/i.test(e.textContent))?.click());
  await sleep(1000);
  check('cached rows wait for their slow avatar', !(await page.$('.notes-feed > .row')));
  await page.waitForSelector(row(seeded[0].id), { timeout: 15000 });
  check('quoted note and mention resolved before admission', await page.$eval(row(seeded[1].id), (n) => n.innerText.includes('Quoted content') && n.innerText.includes('@Mentioned Person')));
  check('all five gallery images decoded before admission', await page.$eval(row(seeded[8].id), (n) => n.querySelectorAll('.note-img').length === 5 && [...n.querySelectorAll('.note-img')].every((i) => i.complete && i.naturalWidth > 0)));
  check('the next page was prefetched before scrolling', requested.has('/next.png'));
  check('an unavailable image remains a usable link', await page.$eval(row(seeded[3].id), (n) => !n.querySelector('img.note-img') && !!n.querySelector('a[href$="/late.png"]')));
  const initial = await snapshot();
  await sleep(3000);
  const settledRows = new Map((await snapshot()).map((r) => [r.id, r]));
  check('late image responses do not change admitted rows', initial.every((r) => JSON.stringify(r) === JSON.stringify(settledRows.get(r.id))));

  // With the header visible, a prepend must wait: anchoring only the first
  // post would otherwise scroll the header offscreen.
  const headerBefore = await page.evaluate(() => ({ y: scrollY, text: document.querySelector('.chat-page').innerText }));
  const fresh = event('A new live post', now + 1);
  check('a live subscription received the event', await page.evaluate((e) => window.__inject(e), fresh) > 0);
  await sleep(1000);
  check('live arrival leaves the visible header and posts untouched', await page.evaluate((before) =>
    scrollY === before.y && document.querySelector('.chat-page').innerText === before.text, headerBefore));
  check('new post waits until it can be inserted offscreen', !(await page.$(row(fresh.id))));

  // Once the reader scrolls the header away, preserve every visible row on
  // every animation frame, including the first frame of the prepend.
  await page.evaluate(() => {
    const first = document.querySelector('.notes-feed > [data-zap-post]');
    scrollBy(0, Math.ceil(first.getBoundingClientRect().top));
    window.__drift = [];
    window.__held = [...document.querySelectorAll('.notes-feed > [data-zap-post]')].filter((r) => {
      const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight;
    }).map((r) => [r, r.getBoundingClientRect().top]);
    window.__sampling = true;
    const frame = () => {
      for (const [r, y] of window.__held) if (!r.isConnected || Math.abs(r.getBoundingClientRect().top - y) > 1) window.__drift.push([r.dataset.key, y, r.getBoundingClientRect().top]);
      if (window.__sampling) requestAnimationFrame(frame);
    }; requestAnimationFrame(frame);
  });
  await page.waitForSelector(row(fresh.id));
  await sleep(500);
  const drift = await page.evaluate(() => { window.__sampling = false; return window.__drift; });
  check('offscreen arrival never moves a visible row, even for one frame', !drift.length, JSON.stringify(drift.slice(0, 3)));
  check('new rows do not animate their height', await page.$eval(row(fresh.id), (n) => !n.getAnimations().length));

  const gap = event('Gap inside visible posts', now - 630);
  await page.evaluate((e) => {
    window.__catchup = [e];
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, gap);
  await sleep(5200);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(1500);
  check('a gap fill does not insert between visible posts', !(await page.$(row(gap.id))));
  await page.evaluate(() => scrollTo(0, 2000));
  await page.waitForSelector(row(gap.id));
  check('the gap fill is admitted once offscreen', !!(await page.$(row(gap.id))));

  await page.$eval(row(seeded[18].id), (n) => n.scrollIntoView());
  await page.waitForSelector(row(seeded[24].id), { timeout: 10000 });
  check('older posts reveal with decoded pictures', await page.$eval(row(seeded[24].id), (n) => { const i = n.querySelector('.note-img'); return !!i && i.complete && i.naturalWidth > 0; }));

  const before = (await snapshot()).find((r) => r.top + r.height > 0);
  await page.evaluate((evs) => {
    window.__catchup = evs;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, Array.from({ length: 25 }, (_, i) => event('Large catch-up ' + i, now + 30 + i)));
  await sleep(5200);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('.notes-feed')?.innerText.includes('Large catch-up 24'), { timeout: 15000 });
  const after = (await snapshot()).find((r) => r.id === before.id);
  check('a large catch-up preserves the reading position', !!after && Math.abs(after.top - before.top) <= 1, JSON.stringify({ before: before.top, after: after?.top }));
  check('no browser errors', !errors.length, errors.join(' | '));
} finally { await browser.close(); server.stop(true); }
process.exit(ok ? 0 : 1);
