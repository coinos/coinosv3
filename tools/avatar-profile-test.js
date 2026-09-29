// Tapping a face in the feed opens that person's profile AT ITS TOP — not
// the thread the row would open, and not the profile scrolled down to
// wherever the reader was in the feed. Back returns to the same place.
//
// Run: bun tools/avatar-profile-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5271, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5271/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  const A = 'a'.repeat(63) + '9', B = 'b'.repeat(63) + '7';
  await page.evaluate(([k, a, b]) => {
    const now = Math.floor(Date.now() / 1000);
    const ns = Array.from({ length: 30 }, (_, i) => ({
      id: (i + 16).toString(16).padStart(64, 'c'), pubkey: i % 2 ? b : a, kind: 1, created_at: now - i * 60,
      content: 'post number ' + i + '\n\n' + 'a few lines so rows have height. '.repeat(4), tags: [],
    }));
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', a], ['p', b]], c: '', at: now }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [a]: { name: 'Alice Poster', t: Date.now() }, [b]: { name: 'Bob Poster', about: 'bob bio here', t: Date.now() } }));
  }, [base, A, B]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => document.querySelector('.app-bottom-nav .app-nav-button').click());
  await waitText('post number 15', 15000);
  await sleep(1500);

  // scroll down to a row well into the feed, then tap its face
  await page.evaluate(() => { const r = [...document.querySelectorAll('.notes-feed .note-avatar')].find((n) => n.closest('[data-key]')?.innerText.includes('post number 13')); r.scrollIntoView({ block: 'center' }); });
  await sleep(700);
  const feedY = await page.evaluate(() => window.scrollY);
  const pt = await page.evaluate(() => { const r = [...document.querySelectorAll('.notes-feed .note-avatar')].find((n) => n.closest('[data-key]')?.innerText.includes('post number 13')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.touchscreen.tap(pt.x, pt.y);
  await sleep(1200);
  const after = await page.evaluate(() => ({ y: window.scrollY, text: document.body.innerText.slice(0, 400), thread: !!document.querySelector('.note-thread, .thread-page') }));
  if (process.env.DBG) console.log(feedY, JSON.stringify(after));
  check('the tap opens the profile', /Bob Poster/.test(after.text) && /bob bio here/.test(after.text), after.text.replace(/\s+/g, ' ').slice(0, 80));
  check('...at its top', after.y < 5, 'scrollY ' + after.y + ' (feed was at ' + feedY + ')');

  await page.goBack().catch(() => {});
  await sleep(1200);
  let back = await page.evaluate(() => ({ y: window.scrollY, feed: !!document.querySelector('.notes-feed') && document.body.innerText.includes('post number 13') }));
  if (!back.feed) {
    await page.evaluate(() => { const b = document.querySelector('.back, [aria-label="Back"]'); if (b) b.click(); });
    await sleep(1200);
    back = await page.evaluate(() => ({ y: window.scrollY, feed: !!document.querySelector('.notes-feed') }));
  }
  check('back returns to the feed where the reader was', back.feed && Math.abs(back.y - feedY) < 60, 'scrollY ' + back.y + ' vs ' + feedY);

  // "Their timeline" from the profile: its chip names it (it was a blank pill)
  await page.evaluate(() => { const r = [...document.querySelectorAll('.notes-feed .note-avatar')].find((n) => n.closest('[data-key]')?.innerText.includes('Bob Poster')); r.click(); });
  await sleep(1000);
  await click('their timeline');
  await sleep(1500);
  const chip = await page.evaluate(() => document.querySelector('.feed-chip.on')?.textContent || null);
  check('someone’s timeline has a labelled chip', !!chip && /Bob Poster/.test(chip), JSON.stringify(chip));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ a face opens its profile at the top' : '\n❌ failed');
process.exit(ok ? 0 : 1);
