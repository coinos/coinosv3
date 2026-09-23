// Lists (NIP-51 follow sets) and linkable posts. A kind-30000 list of yours
// on the relays turns up as a feed; a thread puts its nevent in the address
// bar and its ⋯ menu opens (with Copy link); a profile is /npub1…; "Add to
// a list" from a profile starts a new list that goes out as a kind 30000;
// unticking "Keep as a nostr list" sends the NIP-09 deletion. No relay is
// written for real — the WebSocket shim swallows EVENT and answers OK.
// Run: bun tools/feed-list-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { decode } from 'nostr-tools/nip19';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const MEMBER = getPublicKey(generateSecretKey());
const signed = (content, ago, tags = [], sk = SK) => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000) - ago, tags, content }, sk);
const seeded = [signed('a post to open', 300), signed('another post', 600)];

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5298, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__reqs = [];
  window.__published = [];

  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2]) {
          window.__reqs.push(m[2]);
          const list = window.__list;
          if (list && Array.isArray(m[2].kinds) && m[2].kinds.includes(30000) && m[2].authors && m[2].authors.includes(list.pubkey)) {
            setTimeout(() => {
              ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], list]) }));
              ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
            }, 0);
          }
        }
        // nothing is written to a real relay: swallow it, say OK
        if (m[0] === 'EVENT' && m[1]) {
          window.__published.push(m[1]);
          setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['OK', m[1].id, true, '']) })), 0);
          return;
        }
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; };
const chips = () => page.evaluate(() => [...document.querySelectorAll('.feed-chip')].map((c) => (c.classList.contains('on') ? '*' : '') + c.textContent.trim()));
const path = () => page.evaluate(() => location.pathname);
const type = async (sel, text) => {
  await page.evaluate((q) => { const i = document.querySelector(q); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }, sel);
  await page.click(sel); await page.type(sel, text);
};
const openFeed = async () => {
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'Feed'); if (e) e.click(); });
  await sleep(1200);
};

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5298/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  const ME_SK = privateKeyFromSeedWords(mn);
  const ME = getPublicKey(ME_SK);
  // a list made in another client, under this wallet's own nostr key
  const LIST = finalizeEvent({ kind: 30000, created_at: Math.floor(Date.now() / 1000) - 50, tags: [['d', 'from-coracle'], ['title', 'From Coracle'], ['p', MEMBER]], content: '' }, ME_SK);
  await page.evaluateOnNewDocument((list) => { window.__list = list; }, LIST);
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [base, AUTHOR, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await openFeed();

  console.log('\n[a list made elsewhere is a feed here]');
  check('the relays are asked for my follow sets', await waitFor(() => window.__reqs.some((f) => Array.isArray(f.kinds) && f.kinds.includes(30000))), JSON.stringify((await page.evaluate(() => window.__reqs)).map((f) => f.kinds)));
  check('...and the list shows up as a feed chip', await waitFor(() => [...document.querySelectorAll('.feed-chip')].some((c) => c.textContent.trim() === 'From Coracle'), 12000), JSON.stringify(await chips()));
  await page.evaluate(() => { window.__reqs = []; [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'From Coracle').click(); }); await sleep(1500);
  check('opening it asks for its member\'s posts', (await page.evaluate(() => window.__reqs)).some((f) => f.authors && f.authors.includes(MEMBER)));
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k + ':messages') || '{}').feeds, base);
  const imported = (stored || []).find((f) => f.d === 'from-coracle');
  check('it is saved with its d and clock', !!imported && imported.listAt === LIST.created_at && imported.authors[0] === MEMBER, JSON.stringify(imported || stored));

  console.log('\n[a thread is a link; its ⋯ opens]');
  await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'Following').click()); await sleep(1000);
  check('back on Following, with the seeded post', await waitText('a post to open', 5000));
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /a post to open/.test(n.textContent)); r.click(); }); await sleep(800);
  const p1 = await path();
  let decoded = null; try { decoded = decode(p1.slice(1)); } catch {}
  check('the address bar names the post (nevent)', p1.startsWith('/nevent1') && decoded && decoded.type === 'nevent' && decoded.data.id === seeded[0].id && decoded.data.author === AUTHOR, p1.slice(0, 30));
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-zap-post] button')].find((n) => n.getAttribute('aria-label') === 'More'); b.click(); }); await sleep(400);
  check('the ⋯ menu opens on the thread', await page.evaluate(() => !!document.querySelector('.confirm-pop')));
  check('...with Copy link and Add to a list', await waitText('copy link', 2000) && await waitText('add to a list', 1000));
  await page.evaluate(() => { document.querySelector('.confirm-pop button.btn-ghost').click(); }); await sleep(300);
  check('...and closes', await page.evaluate(() => !document.querySelector('.confirm-pop')));

  console.log('\n[a profile is a link; add its owner to a list]');
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /a post to open/.test(n.textContent)); [...r.querySelectorAll('span')].find((s) => s.style.cursor === 'pointer' && s.style.fontWeight === '600').click(); }); await sleep(1000);
  const p2 = await path();
  let np = null; try { np = decode(p2.slice(1)); } catch {}
  check('the address bar names the person (npub)', p2.startsWith('/npub1') && np && np.data === AUTHOR, p2.slice(0, 30));
  await page.goBack(); await sleep(600);
  check('Back returns to the thread and its address', (await path()) === p1 && await page.evaluate(() => !!document.querySelector('[data-focus-note], .thread-reply-input')));
  await page.goForward(); await sleep(600);
  check('the profile has an Add to a list button', await page.evaluate(() => !![...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add to a list')));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add to a list').click()); await sleep(400);
  check('the list picker shows the feeds, with the imported list', await waitText('from coracle', 2000) && await page.evaluate(() => !!document.querySelector('.list-pick')));
  await page.evaluate(() => { window.__published = []; [...document.querySelectorAll('.list-pick-row')].find((b) => /From Coracle/.test(b.textContent)).click(); }); await sleep(1500);
  const pub1 = (await page.evaluate(() => window.__published)).find((e) => e.kind === 30000);
  check('ticking it publishes the list with them in it', !!pub1 && pub1.pubkey === ME && pub1.tags.some((x) => x[0] === 'd' && x[1] === 'from-coracle') && pub1.tags.some((x) => x[0] === 'p' && x[1] === AUTHOR) && pub1.tags.some((x) => x[0] === 'p' && x[1] === MEMBER) && pub1.created_at > LIST.created_at, JSON.stringify(pub1 && pub1.tags));
  check('...and the picker shows them in it', await page.evaluate(() => { const b = [...document.querySelectorAll('.list-pick-row')].find((x) => /From Coracle/.test(x.textContent)); return b && b.getAttribute('aria-pressed') === 'true'; }));
  await page.evaluate(() => { window.__published = []; [...document.querySelectorAll('.list-pick button')].find((b) => /new list/i.test(b.textContent)).click(); }); await sleep(600);
  check('New list opens the editor with them in it, kept as a list', await waitText('new feed', 3000) && await page.evaluate(() => { const c = document.querySelector('.feed-list-toggle'); return c && c.checked; }));
  await type('input[placeholder="e.g. Bitcoin builders"]', 'Builders');
  await click('save'); await sleep(1500);
  const pub2 = (await page.evaluate(() => window.__published)).find((e) => e.kind === 30000);
  check('saving publishes a kind 30000 with a title and the person', !!pub2 && pub2.tags.some((x) => x[0] === 'title' && x[1] === 'Builders') && pub2.tags.some((x) => x[0] === 'p' && x[1] === AUTHOR), JSON.stringify(pub2 && pub2.tags));
  check('the feed is on screen', JSON.stringify(await chips()).includes('*Builders'), JSON.stringify(await chips()));
  const d2 = pub2 && (pub2.tags.find((x) => x[0] === 'd') || [])[1];

  console.log('\n[unticking removes the list from the relays; the feed stays]');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /edit feed/i.test(b.getAttribute('aria-label') || '')).click()); await sleep(400);
  check('the editor has the list toggle on', await page.evaluate(() => { const c = document.querySelector('.feed-list-toggle'); return c && c.checked; }));
  await page.evaluate(() => { window.__published = []; document.querySelector('.feed-list-toggle').click(); });
  await click('save'); await sleep(1500);
  const del = (await page.evaluate(() => window.__published)).find((e) => e.kind === 5);
  check('a NIP-09 deletion of the list goes out', !!del && del.tags.some((x) => x[0] === 'a' && x[1] === '30000:' + ME + ':' + d2), JSON.stringify(del && del.tags));
  check('...and the feed is still here, no longer a list', JSON.stringify(await chips()).includes('*Builders') && await page.evaluate((k) => { const f = JSON.parse(localStorage.getItem(k + ':messages')).feeds.find((x) => x.name === 'Builders'); return f && !f.d && Object.keys(JSON.parse(localStorage.getItem(k + ':messages')).listsGone || {}).length === 1; }, base));

  console.log('\n[a reload keeps the post, and the person, on screen]');
  await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].find((c) => c.textContent.trim() === 'Following').click()); await sleep(800);
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /a post to open/.test(n.textContent)); r.click(); }); await sleep(800);
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('reloading a thread lands on the thread, at its address', await waitFor(() => !!document.querySelector('.thread-reply-input'), 20000) && (await path()) === p1, await path());
  check('...with its post', await waitText('a post to open', 5000));
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /a post to open/.test(n.textContent)); [...r.querySelectorAll('span')].find((s) => s.style.cursor === 'pointer' && s.style.fontWeight === '600').click(); }); await sleep(800);
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('reloading a profile lands on the profile, at its address', await waitFor(() => !![...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add to a list'), 20000) && (await path()) === p2, await path());
  const hist = () => page.evaluate(() => JSON.stringify({ len: history.length, i: history.state && history.state.i, prof: !!(history.state && history.state.nav && history.state.nav.profilePk), th: !!(history.state && history.state.nav && history.state.nav.noteThread), over: history.state && history.state.nav && history.state.nav.profOverThread, path: location.pathname.slice(0, 12) }));
  const before = await hist();
  await page.goBack(); await sleep(800);
  check('Back from it is the thread again', (await path()) === p1 && await page.evaluate(() => !!document.querySelector('.thread-reply-input')), before + ' -> ' + await hist());
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ lists: a feed of people is a nostr list; posts and people are links' : '\n❌ failed');
process.exit(ok ? 0 : 1);
