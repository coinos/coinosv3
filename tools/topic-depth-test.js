// A topic feed (#gardenstr) goes back as far as the relays remember: the
// big relays prune, so topics also ask archive-keeping ones, and a page
// whose posts were all filtered out (replies, muted, spam) is not the end.
// Before: ~5 posts, then "You're all caught up".
//
// Run: bun tools/topic-depth-test.js
import puppeteer from 'puppeteer-core';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5285, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5285/feed/t/gardenstr', { waitUntil: 'domcontentloaded' });
  const count = () => page.evaluate(() => new Set([...document.querySelectorAll('.notes-feed [data-key]')].map((n) => n.getAttribute('data-key'))).size);
  for (let i = 0; i < 60 && (await count()) < 3; i++) await sleep(500);
  const first = await count();
  check('the topic opens with posts', first >= 3, first + ' posts');
  let seen = new Set(), ended = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000 && seen.size < 60) {
    for (const k of await page.evaluate(() => [...document.querySelectorAll('.notes-feed [data-key]')].map((n) => n.getAttribute('data-key')))) seen.add(k);
    ended = await page.evaluate(() => document.body.innerText.includes('all caught up'));
    if (ended) break;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(1500);
  }
  check('scrolling keeps finding older posts', seen.size >= 40, seen.size + ' posts' + (ended ? ', then "caught up"' : ''));
  check('...without claiming to be caught up after a handful', !ended || seen.size >= 40);
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ a topic goes back' : '\n❌ failed');
process.exit(ok ? 0 : 1);
