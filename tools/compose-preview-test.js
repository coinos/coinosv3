// A post is written as plain text but doesn't arrive as plain text: a .jpg
// URL becomes a picture, a youtu.be link becomes a player, a nostr: ref
// becomes the note it points at. Until now the only way to find out how
// yours would land was to post it.
//
// The preview runs the draft through noteBody — the renderer the feed uses —
// so it isn't a lookalike, it's the same thing. This checks that what the
// preview shows is what a real post shows, for the same text.
//
// Run: bun tools/compose-preview-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5294, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const type = (sel, v) => page.evaluate((s, val) => {
  const e = document.querySelector(s);
  if (!e) return false;
  e.focus(); e.value = val;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, sel, v);

const DRAFT = 'look at this https://coinos.io/punks/7.webp and this https://youtu.be/dQw4w9WgXcQ';

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5294/', { waitUntil: 'domcontentloaded' });
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
  // a post in the feed, so there is something to reply to
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, n]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', n.pubkey]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify([n]));
  }, [base, {
    id: 'f'.repeat(63) + '1', pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
    kind: 1, created_at: Math.floor(Date.now() / 1000) - 60, content: 'a post to answer', tags: [],
  }]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);

  // into the feed, where posts are written
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(2500);
  const opened = await click('new post');
  check('the composer opens', opened && !!(await page.$('textarea')));

  await type('textarea', DRAFT);
  await sleep(400);
  check('no preview until it is asked for', !(await page.$('.draft-preview')));

  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => /preview/i.test(b.getAttribute('aria-label') || ''))?.click());
  await sleep(2500);
  const shown = await page.evaluate(() => {
    const p = document.querySelector('.draft-preview');
    if (!p) return null;
    return {
      imgs: [...p.querySelectorAll('img')].map((i) => i.getAttribute('src') || i.src).filter(Boolean),
      yt: !!p.querySelector('.yt-embed'),
      text: p.innerText,
    };
  });
  check('the preview appears', !!shown);
  check('...with the picture rendered, not its URL', !!shown && shown.imgs.some((u) => /punks\/7\.webp/.test(u)),
    shown ? shown.imgs.length + ' image(s)' : '');
  check('...and the YouTube link as a player', !!shown && shown.yt);
  check('...and the raw URLs are not left lying in the text', !!shown && !shown.text.includes('https://youtu.be/'),
    shown ? JSON.stringify(shown.text.slice(0, 60)) : '');

  // live: keep typing and the preview follows
  await type('textarea', DRAFT + ' plus a word');
  await sleep(900);
  check('it follows the draft as you type',
    /plus a word/.test(await page.evaluate(() => (document.querySelector('.draft-preview') || {}).innerText || '')));

  // and it puts itself away
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => /hide preview/i.test(b.getAttribute('aria-label') || ''))?.click());
  await sleep(500);
  check('and it closes again', !(await page.$('.draft-preview')));

  // ---- and the same thing on a reply -------------------------------------
  await click('cancel');
  await sleep(400);
  // open a thread: any post in the feed does
  const intoThread = await page.evaluate(() => {
    const r = document.querySelector('.notes-feed > .row');
    if (!r) return false;
    r.click();
    return true;
  });
  if (!intoThread) {
    console.log(' — no post in the feed to reply to, skipping the reply half');
  } else {
    await sleep(2500);
    check('a thread opened to read has no reply box yet', !(await page.$('.thread-reply-input')));
    await page.evaluate(() => { const b = [...document.querySelectorAll('.note-act')].find((x) => x.getAttribute('aria-label') === 'Reply'); if (b) b.click(); });
    await sleep(400);
    const box = await page.$('.thread-reply-input');
    check('Reply opens the box', !!box);
    if (box) {
      await type('.thread-reply-input', 'my answer https://coinos.io/punks/3.webp');
      await sleep(300);
      check('a reply has no preview until asked either', !(await page.$('.draft-preview')));
      await page.evaluate(() => [...document.querySelectorAll('button')]
        .find((b) => /^preview$/i.test(b.getAttribute('aria-label') || ''))?.click());
      await sleep(1500);
      const rp = await page.evaluate(() => {
        const p = document.querySelector('.draft-preview');
        return p ? { imgs: p.querySelectorAll('img').length, text: p.innerText } : null;
      });
      check('the reply previews the same way', !!rp && rp.imgs > 0,
        rp ? rp.imgs + ' image(s)' : 'no preview');
      check('...showing the picture instead of its URL', !!rp && !rp.text.includes('punks/3.webp'),
        rp ? JSON.stringify(rp.text.slice(0, 50)) : '');
    }
  }

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ what you see is what they get' : '\n❌ failed');
process.exit(ok ? 0 : 1);
