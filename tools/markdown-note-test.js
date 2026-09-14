// A kind 1 is specified as plain text — NIP-10 says markup SHOULD NOT be
// used — but bridges and cross-posters emit markdown anyway, and what we did
// with it was the worst of the three options available: the URL inside
// ![cover](…) rendered as a picture while the "![cover](" sat above it as
// litter, in a real post from a real account.
//
// So: images and links are understood, and nothing else is. # opens a hashtag
// and * turns up in ordinary prose, so honouring headings and bold would
// mangle normal posts to pretty up the rare bridged one.
//
// Run: bun tools/markdown-note-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const IMG = 'https://coinos.io/punks/7.webp';
const NOEXT = 'https://example.invalid/media/9f2a1c';
// the shape the real post had: the paren, then a newline, then the URL
const CASES = [
  ['md-image', 'here it is\n![cover](' + IMG + ')\nthat was it'],
  ['md-image-newline', 'wrapped\n![cover](\n' + IMG + ')\ndone'],
  ['md-image-noext', 'no extension ![cover](' + NOEXT + ')'],
  ['md-link', 'read it at [my site](https://example.invalid/post/1) today'],
  ['bare', 'plain old ' + IMG + ' here'],
  ['not-md', 'a list [one] and (two) and #hashtag and *stars* stay put'],
];
const notes = CASES.map(([, content], i) =>
  finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000) - i * 60, tags: [], content }, SK));

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5298, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5298/', { waitUntil: 'domcontentloaded' });
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
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [cacheKeyFor(mn + '\n'), AUTHOR, notes]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(4000);

  const rows = await page.evaluate(() => [...document.querySelectorAll('.notes-feed > .row')].map((r) => {
    const b = r.querySelector('.note-text');
    return {
      text: b ? b.innerText : '',
      imgs: b ? [...b.querySelectorAll('img')].map((i) => i.getAttribute('src')) : [],
      links: b ? [...b.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), txt: a.textContent })) : [],
    };
  }));
  check('all six posts are on screen', rows.length === 6, rows.length + ' rows');
  const by = (i) => rows[i] || { text: '', imgs: [], links: [] };

  // 0: the reported case
  check('![alt](url) shows the picture', by(0).imgs.includes(IMG), by(0).imgs.join(' '));
  check('...and leaves no "![cover](" behind', !/!\[|\]\(/.test(by(0).text), JSON.stringify(by(0).text));
  // 1: with the newline the real post had
  check('...even with a newline after the paren', by(1).imgs.includes(IMG) && !/!\[|\]\(/.test(by(1).text),
    JSON.stringify(by(1).text));
  // 2: markdown knows it's an image even without an extension
  check('![…] means picture even with no file extension', by(2).imgs.includes(NOEXT), by(2).imgs.join(' '));
  // 3: a plain markdown link is a link with its own words
  const l = by(3).links.find((x) => /example\.invalid\/post\/1/.test(x.href || ''));
  check('[text](url) is a link labelled with its text', !!l && l.txt === 'my site', l ? l.txt : 'no link');
  check('...and the brackets are gone', !/\[my site\]/.test(by(3).text), JSON.stringify(by(3).text));
  // 4: bare URLs unchanged
  check('a bare image URL still just works', by(4).imgs.includes(IMG));
  // 5: everything that ISN'T markdown is left exactly alone
  check('brackets, parens, hashtags and stars in prose are untouched',
    by(5).text.includes('[one]') && by(5).text.includes('(two)')
      && by(5).text.includes('#hashtag') && by(5).text.includes('*stars*'),
    JSON.stringify(by(5).text));

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ markdown reads as what it means' : '\n❌ failed');
process.exit(ok ? 0 : 1);
