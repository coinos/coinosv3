// What you can do to a post: like it, boost it, quote it, and — behind the
// ellipsis — mute or block whoever wrote it. Muting hides their posts here
// and goes onto the NIP-51 list that follows you to other clients.
//
// The like and boost tallies come back in the same REQ as the zaps; this
// checks the rendering and the local half of each action (nothing here needs
// a relay to answer, so the test doesn't depend on one).
//
// Run: bun tools/post-actions-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const png = await Bun.file('/tmp/claude-1000/-home-adam-coinosv3/61dea255-d26d-411d-be8b-92dfb0a75887/scratchpad/big.png').arrayBuffer().catch(() => null);
const server = Bun.serve({ port: 5258, async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === '/pic.png' && png) return new Response(png, { headers: { 'content-type': 'image/png' } });
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms/250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const AUTHOR = 'a'.repeat(63) + '9';
// a fresh id each run: '1'.repeat(64) is a real, much-reacted-to id on nostr
// and the relays cheerfully return four likes for it
const NOTE_ID = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5258/', { waitUntil: 'domcontentloaded' });
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

  await page.evaluate(([k, pk, nid]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now()/1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify([
      { id: nid, pubkey: pk, kind: 1, created_at: Math.floor(Date.now()/1000), content: 'More flowers http://localhost:5258/pic.png', tags: [] },
    ]));
  }, [base, AUTHOR, NOTE_ID]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(2500);

  const acts = await page.evaluate(() => [...document.querySelectorAll('.note-act')].map((b) => b.getAttribute('aria-label')));
  check('every action sits under the post', acts.slice(0, 4).join(',') === 'Reply,Boost,Quote,Like', acts.join(',') || 'none');

  // the heart opens the emoji row; picking one paints before any relay answers
  const likeBtn = () => page.evaluate(() => { const b = [...document.querySelectorAll('.note-act')].find((x) => x.getAttribute('aria-label') === 'Like'); return b ? { on: b.className.includes('on'), n: Number(b.textContent.replace(/\D/g, '') || 0), emoji: b.textContent.replace(/[\d\s]/g, '') } : null; });
  const before = (await likeBtn()).n;
  await page.evaluate(() => { const b = [...document.querySelectorAll('.note-act')].find((x) => x.getAttribute('aria-label') === 'Like'); b.click(); });
  await sleep(600);
  const emojis = await page.evaluate(() => [...document.querySelectorAll('.msg-sheet-emojis button')].map((b) => b.textContent));
  check('the heart offers a choice of emoji', emojis.length >= 5, emojis.join(' '));
  await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-sheet-emojis button')].find((x) => x.textContent === '🔥'); b.click(); });
  await sleep(1200);
  const liked = await likeBtn();
  check('the one you picked is the one it shows', liked.on && liked.n === before + 1 && liked.emoji.includes('🔥'), JSON.stringify(liked) + ' was ' + before);

  // quoting carries the post into the composer as a nostr: reference
  await page.evaluate(() => { const b = [...document.querySelectorAll('.note-act')].find((x) => x.getAttribute('aria-label') === 'Quote'); b.click(); });
  await sleep(900);
  const draft = await page.evaluate(() => (document.querySelector('.chat-page textarea') || {}).value || '');
  check('quoting opens the composer with the reference in it', /nostr:nevent1/.test(draft), draft.slice(0, 40) || 'empty');

  // the ellipsis sheet, and muting from it
  await page.evaluate(() => { const b = [...document.querySelectorAll('.btn-sm')].find((x) => x.textContent.trim() === '⋯'); if (b) b.click(); });
  await sleep(600);
  const sheet = await page.evaluate(() => { const s = document.querySelector('.confirm-pop'); return s ? s.innerText.replace(/\n+/g, ' | ') : ''; });
  check('the ellipsis offers mute and block', /Mute/.test(sheet) && /Block/.test(sheet), sheet.slice(0, 70));

  await page.evaluate(() => { const b = [...document.querySelectorAll('.confirm-pop button')].find((x) => /^🔇/.test(x.textContent)); if (b) b.click(); });
  await sleep(2500);
  const after = await page.evaluate((k) => ({
    rows: document.querySelectorAll('.notes-feed > .row').length,
    muted: (JSON.parse(localStorage.getItem(k + ':mutes') || 'null') || {}).tags || [],
  }), base);
  check('a muted author leaves the feed at once', after.rows === 0, after.rows + ' posts still shown');
  check('...and goes onto the published mute list', after.muted.some((tg) => tg[1] === AUTHOR), JSON.stringify(after.muted).slice(0, 50));
  // An image in a DM opens the same way a post's does — both bubbles render
  // their text through the same function, so this is a check that they keep
  // doing so.
  await page.evaluate(([k, peer]) => {
    const st = JSON.parse(localStorage.getItem(k + ':messages') || '{}');
    st.dms = { [peer]: [{ id: '2'.repeat(64), from: peer, text: 'look http://localhost:5258/pic.png', t: Math.floor(Date.now() / 1000) }] };
    localStorage.setItem(k + ':messages', JSON.stringify(st));
  }, [base, AUTHOR]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(2500);
  const opened = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-thread-row')].find((r) => !/feed/i.test(r.textContent));
    if (!row) return 'no dm row';
    row.click();
    return 'opened';
  });
  await sleep(1200);
  const img = await page.evaluate(() => { const i = document.querySelector('.chat-bubble img.note-img'); if (!i) return null; i.click(); return true; });
  await sleep(600);
  check('an image in a DM opens full screen too', !!img && await page.evaluate(() => !!document.querySelector('.lightbox')), img ? 'tapped' : 'no image in the bubble (' + opened + ')');

  check('no page errors', !errs.length, errs.join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ posts answer back' : '\n❌ failed');
process.exit(ok ? 0 : 1);
