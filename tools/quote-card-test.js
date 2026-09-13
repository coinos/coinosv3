// A nostr:note1/nevent1 in someone's post IS a post: show it inside what they
// said about it, the way every other nostr client does, rather than making
// the reader tap "view note" and lose their place.
//
// The quoted event is fetched from real relays here — the note used is
// fiatjaf's, chosen because it will still be there tomorrow.
//
// Run: bun tools/quote-card-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { neventOf } from '../src/nostr.js';
import { buildHtml } from '../build.js';
import { SimplePool } from 'nostr-tools/pool';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

// something real to quote: a recent note from an author who posts a lot
const pool = new SimplePool();
const FIATJAF = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const found = await pool.querySync(['wss://relay.primal.net', 'wss://nos.lol'],
  { kinds: [1], authors: [FIATJAF], limit: 5 }, { maxWait: 6000 }).catch(() => []);
const target = (found || []).filter((e) => e.content && e.content.length > 20)[0];
if (!target) { console.log(' ✗ no note to quote (relays quiet)'); process.exit(1); }
const nevent = neventOf(target.id, target.pubkey);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5269, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5269/', { waitUntil: 'domcontentloaded' });
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
  const A = 'a'.repeat(63) + '9';
  await page.evaluate(([k, pk, ref]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now()/1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify([
      { id: 'd'.repeat(64), pubkey: pk, kind: 1, created_at: Math.floor(Date.now()/1000), content: 'what he said nostr:' + ref, tags: [] },
    ]));
  }, [base, A, nevent]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(7000);

  const card = await page.evaluate(() => {
    const q = document.querySelector('.quote-card');
    if (!q) return null;
    return { text: q.innerText.replace(/\n+/g, ' | ').slice(0, 90), hasAvatar: !!q.querySelector('.chat-avatar'), inPost: !!q.closest('.notes-feed') };
  });
  check('the quoted note is shown, not linked to', !!card, card ? 'rendered' : 'no card');
  check('...inside the post that quotes it', !!(card && card.inPost));
  check('...with whose note it is', !!(card && card.hasAvatar), card ? card.text.slice(0, 50) : '');
  const body = target.content.replace(/\s+/g, ' ').slice(0, 24);
  check('...and what it actually said', !!(card && card.text.replace(/\s+/g, ' ').includes(body.slice(0, 18))), body);
  check('no "view note" link left in the post', !(await page.evaluate(() => document.body.innerText)).includes('view note'));
  // the outer post keeps its actions; the quote has none of its own
  const acts = await page.evaluate(() => ({
    outer: document.querySelectorAll('.notes-feed > .row .note-acts').length,
    inside: document.querySelectorAll('.quote-card .note-acts').length,
  }));
  check('the quote is context, not a second post to act on', acts.outer >= 1 && acts.inside === 0, JSON.stringify(acts));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ quotes read as quotes' : '\n❌ failed');
process.exit(ok ? 0 : 1);
