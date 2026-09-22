// Custom feeds: Following is one feed among many. A new feed from the +
// chip (people and/or topics), the filter it asks relays for, a tagged
// post landing in it, switching back, a #tag in a post opening a topic
// feed, and deleting a feed. No relays are contacted for real — the
// WebSocket shim answers the subscriptions.
// Run: bun tools/feed-custom-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { naddrEncode } from 'nostr-tools/nip19';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const OTHER_SK = generateSecretKey();
const signed = (content, ago, tags = [], sk = SK) => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000) - ago, tags, content }, sk);
const seeded = [signed('hello from the feed, about #bitcoin today', 300), signed('plain post', 600)];
// a follow pack (NIP-51 kind 39089) curated by someone else, with one member
const CURATOR_SK = generateSecretKey();
const MEMBER = getPublicKey(generateSecretKey());
const PACK = finalizeEvent({ kind: 39089, created_at: Math.floor(Date.now() / 1000) - 100, tags: [['d', 'test-pack'], ['title', 'Test pack'], ['p', MEMBER]], content: '' }, CURATOR_SK);
const PACK_LINK = 'https://following.space/d/test-pack?p=' + PACK.pubkey; // the form following.space shares
const PACK_NADDR = naddrEncode({ kind: 39089, pubkey: PACK.pubkey, identifier: 'test-pack', relays: [] });

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5297, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((pack) => {
  window.__reqs = [];
  window.__pack = pack;
  const subs = [];
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2] && Array.isArray(m[2].kinds) && m[2].kinds.includes(1)) { window.__reqs.push(m[2]); subs.push([ws, m[1], m[2]]); }
        if (m[0] === 'REQ' && m[2] && Array.isArray(m[2].kinds) && m[2].kinds.includes(39089) && (!m[2].authors || m[2].authors.includes(window.__pack.pubkey))) {
          setTimeout(() => {
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], window.__pack]) }));
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
          }, 0);
        }
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
  window.__origOpen = true;
  // hand a post to every open kind-1 subscription whose filter it matches
  window.__inject = (ev) => {
    let n = 0;
    for (const [ws, id, f] of subs) {
      if (ws.readyState !== 1) continue;
      if (f.authors && !f.authors.includes(ev.pubkey)) continue;
      if (f['#t'] && !ev.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) continue;
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', id, ev]) }));
      n++;
    }
    return n;
  };
}, PACK);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const chips = () => page.evaluate(() => [...document.querySelectorAll('.feed-chip')].map((c) => (c.classList.contains('on') ? '*' : '') + c.textContent.trim()));
const type = async (sel, text) => {
  await page.evaluate((q) => { const i = document.querySelector(q); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }, sel);
  await page.click(sel); await page.type(sel, text);
};

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5297/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  // through the real first run: the wizard's own words, read off the screen
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  // the starter follows land once the current list has been asked for
  let starter = false;
  for (let i = 0; i < 60 && !starter; i++) { starter = await page.evaluate((k) => { const f = JSON.parse(localStorage.getItem(k + ':follows') || '{}'); const set = new Set((f.tags || []).filter((t) => t[0] === 'p').map((t) => t[1])); return set.has('98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7') && set.has('72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb'); }, base); if (!starter) await sleep(500); }
  check('a new identity follows the coinos people', starter);
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [base, AUTHOR, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(1200);
  check('the feed opens on Following, with a + chip', JSON.stringify(await chips()) === JSON.stringify(['*Following', '#gardenstr', '+']), JSON.stringify(await chips()));

  console.log('\n[a new feed: everyone I follow, on one topic]');
  await page.click('.feed-chip.add'); await sleep(300);
  check('the editor opens', await waitText('new feed', 3000));
  await type('input[placeholder="e.g. Bitcoin builders"]', 'Coin talk');
  await page.click('input[type=checkbox]');
  await type('input[placeholder="#bitcoin #nostr"]', '#Bitcoin, lightning');
  await click('save'); await sleep(1500);
  check('the new feed is on screen and selected', JSON.stringify(await chips()) === JSON.stringify(['Following', '#gardenstr', '*Coin talk', '+']), JSON.stringify(await chips()));
  const req = (await page.evaluate(() => window.__reqs)).find((f) => f['#t']);
  check('it asks relays for the follows AND the topics', !!req && req.authors?.includes(AUTHOR) && JSON.stringify(req['#t']) === JSON.stringify(['bitcoin', 'lightning']), JSON.stringify(req || null));
  const tagged = signed('fresh #bitcoin post', 0, [['t', 'bitcoin']]);
  const n = await page.evaluate((ev) => window.__inject(ev), tagged);
  await sleep(2800);
  check('a tagged post lands in it', n > 0 && await waitText('fresh #bitcoin post', 4000), n + ' sub(s)');
  const untagged = signed('an untagged post', 0);
  await page.evaluate((ev) => window.__inject(ev), untagged); await sleep(1500);
  check('an untagged one does not', !(await page.evaluate(() => document.body.innerText)).includes('an untagged post'));

  console.log('\n[back to Following, and a #tag in a post]');
  await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'Following').click()); await sleep(1200);
  check('Following again, with its own posts', (await chips())[0] === '*Following' && await waitText('plain post', 4000));
  await page.evaluate(() => { const a = [...document.querySelectorAll('.notes-feed a')].find((x) => x.textContent === '#bitcoin'); if (a) a.click(); }); await sleep(1200);
  check('a #tag opens a topic feed of its own', JSON.stringify(await chips()) === JSON.stringify(['Following', '#gardenstr', 'Coin talk', '*#bitcoin', '+']) && await page.evaluate(() => !![...document.querySelectorAll('button')].find((b) => /save feed/i.test(b.textContent))), JSON.stringify(await chips()));
  const treq = (await page.evaluate(() => window.__reqs)).filter((f) => f['#t'] && !f.authors).pop();
  check('...asked for by topic alone', !!treq && JSON.stringify(treq['#t']) === JSON.stringify(['bitcoin']), JSON.stringify(treq || null));

  console.log('\n[a follow pack from following.space]');
  await page.click('.feed-chip.add'); await sleep(300);
  await type('input[placeholder="e.g. Bitcoin builders"]', 'Pack feed');
  await type('input[placeholder="Search packs, or paste a following.space link…"]', 'tes');
  check('a few letters of the title find the pack', await waitText('test pack', 8000) && await waitText('1 members', 2000));
  await type('input[placeholder="Search packs, or paste a following.space link…"]', 'zzzz');
  await sleep(900);
  check('...and letters that match nothing find nothing', !(await page.evaluate(() => document.body.innerText)).includes('Test pack'));
  await type('input[placeholder="Search packs, or paste a following.space link…"]', PACK_NADDR);
  check('a bare naddr finds it', await waitText('test pack', 6000));
  await type('input[placeholder="Search packs, or paste a following.space link…"]', PACK_LINK);
  await sleep(900);
  check('a pasted following.space link finds it', await waitText('test pack', 6000));
  await page.evaluate(() => [...document.querySelectorAll('.row')].find((r) => /Test pack/.test(r.textContent) && !r.querySelector('button')).click()); await sleep(300);
  check('...and adds it to the feed', await page.evaluate(() => [...document.querySelectorAll('.row')].some((r) => /Test pack/.test(r.textContent) && r.querySelector('button'))));
  await page.evaluate(() => { window.__reqs = []; });
  await click('save'); await sleep(1500);
  const anyMember = (await page.evaluate(() => window.__reqs)).some((f) => f.authors && f.authors.includes(MEMBER));
  check('the feed asks relays for the pack\'s member', anyMember, JSON.stringify((await page.evaluate(() => window.__reqs)).map((f) => (f.authors || []).map((a) => a.slice(0, 8)))));

  console.log('\n[the feeds survive a reload; a feed can be deleted]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); }); await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); }); await sleep(1200);
  check('the saved feeds are still there; the session topic is not', JSON.stringify(await chips()) === JSON.stringify(['*Following', '#gardenstr', 'Coin talk', 'Pack feed', '+']), JSON.stringify(await chips()));
  check('the home list shows the pack feed with its pack', await page.evaluate(() => { const b = document.querySelector('.chat-back'); if (b) b.click(); return !!b; }) && await waitText('test pack', 3000));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'Feed'); if (e) e.click(); }); await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'Coin talk').click()); await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /edit feed/i.test(b.getAttribute('aria-label') || '')).click()); await sleep(400);
  check('the editor shows what was saved', await page.evaluate(() => document.querySelector('input[placeholder="#bitcoin #nostr"]').value === '#bitcoin #lightning' && document.querySelector('input[type=checkbox]').checked));
  await click('delete feed'); await sleep(1000);
  check('deleting it lands back on Following', JSON.stringify(await chips()) === JSON.stringify(['*Following', '#gardenstr', 'Pack feed', '+']), JSON.stringify(await chips()));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ feeds: Following is one of many' : '\n❌ failed');
process.exit(ok ? 0 : 1);
