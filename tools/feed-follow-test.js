// Follows and the feed: the Follow button reflects the contact list, the feed
// reads the people on it, and a brand-new wallet is told what to do instead
// of being shown an empty box.
//
// Nothing here publishes to a relay — the contact list is seeded locally, the
// way it would arrive from one.
//
// Run: bun tools/feed-follow-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { npubEncode } from 'nostr-tools/nip19';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5237, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const clickItem = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('.item, button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await text()).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const FOLLOWED = 'e'.repeat(63) + '1';
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5237/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('get started'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  const mnemonic = generateMnemonic(wordlist);
  await page.type('textarea', mnemonic);
  await click('open wallet');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mnemonic + '\n');

  // chat → the feed is offered before the conversations
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1200);
  check('the feed is on the messages home', /follow people to fill this/i.test(await text()), (await text()).split('\n').slice(0, 6).join(' | '));

  await clickItem('feed');
  await sleep(1000);
  check('a wallet that follows nobody is told so', /don't follow anyone yet/i.test(await text()));
  check('...and offered somewhere to start', /find people/i.test(await text()));

  // a contact list, as a relay would hand it over
  await page.evaluate(([k, pk]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
  }, [base, FOLLOWED]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1200);
  check('the follow count shows on the messages home', /posts from the one person you follow/i.test(await text()), (await text()).match(/Posts from[^\n]*/)?.[0] || 'no line');

  // and their own profile page knows we follow them
  await page.goto('http://localhost:5237/' + npubEncode(FOLLOWED), { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const btns = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
  check('their profile offers to unfollow, not to follow', btns.includes('Following') && !btns.includes('Follow'),
    btns.filter((b) => /follow/i.test(b)).join(',') || 'no follow button');
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ follows and feed' : '\n❌ failed');
process.exit(ok ? 0 : 1);
