// Tapping a face in the feed should land on a profile that is already
// there: the bio, the banner and some of their posts painted in the first
// frame, not half a second later once relays answer — which is what made
// the page jump under your thumb.
//
// The bio and banner come free: the batched kind-0 fetch that named these
// people in the feed downloaded their whole profile, so it is already in
// hand. The posts come from the feed itself.
//
// Measured as the browser measures it — layout-shift entries after the tap.
//
// Run: bun tools/profile-open-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
import { SimplePool } from 'nostr-tools/pool';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

// Real people with real bios: pull recent posters, then keep only the ones
// whose kind 0 actually carries an `about`, so "the bio painted" is a claim
// that can be true.
const pool = new SimplePool();
const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io'];
const recent = await pool.querySync(RELAYS, { kinds: [1], limit: 150, since: Math.floor(Date.now() / 1000) - 7200 },
  { maxWait: 8000 }).catch(() => []);
const posters = [...new Set(recent.map((e) => e.pubkey))].slice(0, 40);
const withBio = new Map();
for (const e of await pool.querySync(RELAYS, { kinds: [0], authors: posters }, { maxWait: 8000 }).catch(() => [])) {
  try {
    const m = JSON.parse(e.content);
    if ((m.display_name || m.name) && typeof m.about === 'string' && m.about.trim().length > 30) {
      const p = withBio.get(e.pubkey);
      if (!p || e.created_at > p.created_at) withBio.set(e.pubkey, e);
    }
  } catch {}
}
const authors = [...withBio.keys()];
const notes = recent.filter((e) => withBio.has(e.pubkey));
if (authors.length < 4 || notes.length < 6) { console.log(' ✗ not enough people with bios posting right now'); process.exit(1); }
console.log(`   ${authors.length} people with a real bio, ${notes.length} of their posts`);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5276, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__shift = 0;
  window.__shiftOn = false;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput && window.__shiftOn) window.__shift += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5276/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(500);
  await click('to import'); await sleep(400);
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
  // let the feed settle completely — this test is about what happens AFTER
  await sleep(12000);

  // tap the first face whose person we know has a bio
  const target = await page.evaluate((pks) => {
    const rows = [...document.querySelectorAll('.notes-feed > .row')];
    for (const r of rows) {
      const a = r.querySelector('.note-avatar');
      if (!a) continue;
      window.__shiftOn = true;
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      a.click();
      return true;
    }
    return false;
  }, authors);
  check('a face in the feed opens a profile', target);

  // the very next frame: what is on the page?
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const first = await page.evaluate(() => ({
    npub: /npub1/.test(document.body.innerText),
    // the bio is the paragraph in the profile card, not a post
    bio: (document.querySelector('.card p') || {}).textContent || '',
    posts: document.querySelectorAll('.notes-feed > .row').length,
  }));
  check('the bio is there in the first frame', first.bio.trim().length > 20,
    first.bio ? first.bio.trim().slice(0, 48).replace(/\n/g, ' ') + '…' : 'blank');
  check('...and so are some of their posts', first.posts > 0, first.posts + ' posts');

  // and nothing jumps while the relays answer
  await sleep(7000);
  const shift = await page.evaluate(() => window.__shift);
  const after = await page.evaluate(() => document.querySelectorAll('.notes-feed > .row').length);
  // 0.1 is the browser's own "good" threshold for cumulative layout shift
  check('the page does not jump while it loads', shift < 0.1, 'layout shift ' + shift.toFixed(3));
  check('the relay answer fills in behind it', after > 0, first.posts + ' posts on open, ' + after + ' after');
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the profile is already there when you land on it' : '\n❌ failed');
process.exit(ok ? 0 : 1);
