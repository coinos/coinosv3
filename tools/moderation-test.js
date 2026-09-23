// Moderation: the mute list (people, words, hashtags, threads) applies to
// the feed and to thread replies; a post reported by someone you follow is
// folded with a Show; Report… from the ⋯ menu publishes a kind 1984 and
// hides the post; repeated posts and hashtag-stuffed posts from strangers
// are hidden; Settings → Nostr lays the mute list out and edits it.
// No relay is written for real — the WebSocket shim swallows EVENT.
// Run: bun tools/moderation-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const AUTHOR = key(), MUTED = key(), REPORTED = key(), OTHER = key(), SPAMMER = key(), TAGGER = key();
const now = Math.floor(Date.now() / 1000);
const post = (who, content, ago, tags = []) => finalizeEvent({ kind: 1, created_at: now - ago, tags, content }, who.sk);
const ROOT = post(AUTHOR, 'a post to open, about #bitcoin and other things', 300);
const THREADMUTED = post(AUTHOR, 'another post, in a thread I muted', 400);
const seeded = [
  ROOT,
  THREADMUTED,
  post(MUTED, 'muted person post', 500),
  post(AUTHOR, 'my friend loves lasagna apparently', 600),
  post(AUTHOR, 'tagged post', 700, [['t', 'nsfw']]),
  post(REPORTED, 'reported post here, flagged by my friend', 800),
];
const reply = (who, text, ago) => post(who, text, ago, [['e', ROOT.id, '', 'root'], ['p', AUTHOR.pk]]);
const REPLIES = [reply(OTHER, 'reply from ok person', 200), reply(MUTED, 'reply from muted person', 150)];
const LONG = 'buy the dip now, best exchange ever, sign up with my link and get free sats today!!!';

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5299, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((fx) => {
  window.__reqs = [];
  window.__published = [];
  const subs = [];
  const Real = window.WebSocket;
  const answer = (ws, id, evs) => setTimeout(() => {
    for (const ev of evs) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', id, ev]) }));
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', id]) }));
  }, 0);
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2]) {
          const f = m[2];
          window.__reqs.push(f);
          const kinds = f.kinds || [];
          if (kinds.includes(10000) && window.__mutes && (f.authors || []).includes(window.__mutes.pubkey)) answer(ws, m[1], [window.__mutes]);
          else if (kinds.includes(1984) && (f.authors || []).includes(fx.author)) answer(ws, m[1], [fx.report]);
          else if (kinds.includes(1) && f['#e'] && f['#e'].includes(fx.root)) answer(ws, m[1], fx.replies);
          else if (kinds.includes(1)) subs.push([ws, m[1], f]);
        }
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
}, { author: AUTHOR.pk, root: ROOT.id, replies: REPLIES, report: finalizeEvent({ kind: 1984, created_at: now - 100, tags: [['e', seeded[5].id, 'spam'], ['p', REPORTED.pk]], content: '' }, AUTHOR.sk) });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await text()).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; };
const has = async (x) => (await text()).includes(x);
const openFeed = async () => {
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(800);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'Feed'); if (e) e.click(); });
  await sleep(1200);
};

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5299/', { waitUntil: 'domcontentloaded' });
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
  // the mute list as another client left it: a person, a word, a hashtag, a thread
  const MUTES = finalizeEvent({ kind: 10000, created_at: now - 50, tags: [['p', MUTED.pk], ['word', 'Lasagna'], ['t', 'NSFW'], ['e', THREADMUTED.id]], content: '' }, ME_SK);
  await page.evaluateOnNewDocument((m) => { window.__mutes = m; }, MUTES);
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [base, AUTHOR.pk, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await openFeed();

  console.log('\n[the mute list, every kind of entry, on the feed]');
  check('the relays are asked for my mute list', await waitFor(() => window.__reqs.some((f) => (f.kinds || []).includes(10000))));
  check('a friend\'s post shows', await waitText('a post to open', 8000));
  check('...a muted person\'s does not', await waitFor(() => !document.body.innerText.includes('muted person post'), 8000));
  check('...nor one with a hidden word', !(await has('lasagna')));
  check('...nor one on a muted hashtag', !(await has('tagged post')));
  check('...nor one in a muted thread', !(await has('another post, in a thread')));

  console.log('\n[a post my friend reported is folded]');
  check('the relays are asked for my follows\' reports', await waitFor(() => window.__reqs.some((f) => (f.kinds || []).includes(1984)), 15000));
  check('the flagged post is folded, naming who', await waitText('reported by', 12000) && !(await has('reported post here')), (await text()).match(/Reported by[^\n]*/)?.[0]);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.note-folded button')].find((x) => /show/i.test(x.textContent)); b.click(); }); await sleep(400);
  check('Show unfolds it', await has('reported post here'));

  console.log('\n[thread replies go through the same door; Report… hides and publishes]');
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /a post to open/.test(n.textContent)); r.click(); }); await sleep(1500);
  check('an ordinary reply shows in the thread', await waitText('reply from ok person', 8000));
  check('...a muted person\'s reply does not', !(await has('reply from muted person')));
  await page.evaluate(() => { const r = [...document.querySelectorAll('[data-zap-post]')].find((n) => /reply from ok person/.test(n.textContent)); [...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); }); await sleep(300);
  check('the ⋯ menu offers Report and Mute this thread', await has('Report…') && await has('Mute this thread'));
  await page.evaluate(() => { window.__published = []; [...document.querySelectorAll('.confirm-pop button')].find((b) => /report/i.test(b.textContent)).click(); }); await sleep(300);
  check('a reason sheet opens', await page.evaluate(() => !!document.querySelector('.report-pick')));
  await page.evaluate(() => document.querySelector('.report-reason[data-reason="spam"]').click()); await sleep(1200);
  const rep = (await page.evaluate(() => window.__published)).find((e) => e.kind === 1984);
  check('a kind 1984 goes out: the reply, as spam, its author credited', !!rep && rep.pubkey === ME && rep.tags.some((x) => x[0] === 'e' && x[1] === REPLIES[0].id && x[2] === 'spam') && rep.tags.some((x) => x[0] === 'p' && x[1] === OTHER.pk), JSON.stringify(rep && rep.tags));
  check('...and the reply is hidden for me', !(await has('reply from ok person')));
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].filter((x) => /back/i.test(x.textContent)).pop(); b.click(); }); await sleep(800);

  console.log('\n[strangers: repeated posts and hashtag stuffing]');
  await page.evaluate(() => { const a = [...document.querySelectorAll('.notes-feed a')].find((x) => x.textContent === '#bitcoin'); a.click(); }); await sleep(1500);
  check('a #bitcoin topic feed is open', await page.evaluate(() => [...document.querySelectorAll('.feed-chip.on')].some((c) => c.textContent.trim() === '#bitcoin')));
  const dupes = [];
  for (let i = 0; i < 6; i++) dupes.push(post(SPAMMER, LONG, 60 - i, [['t', 'bitcoin']]));
  let n = 0;
  for (const ev of dupes) { n += await page.evaluate((e) => window.__inject(e), ev); await sleep(150); }
  const control = post(OTHER, 'a fine post from a stranger on #bitcoin', 10, [['t', 'bitcoin']]);
  await page.evaluate((e) => window.__inject(e), control);
  const stuffed = post(TAGGER, 'airdrop ' + Array.from({ length: 14 }, (_, i) => '#tag' + i).join(' '), 5, [['t', 'bitcoin'], ...Array.from({ length: 14 }, (_, i) => ['t', 'tag' + i])]);
  await page.evaluate((e) => window.__inject(e), stuffed);
  await sleep(3500);
  check('a stranger\'s ordinary post lands', n > 0 && await waitText('a fine post from a stranger', 6000), n + ' sub(s)');
  check('six copies of the same pitch do not: the spammer is hidden', !(await has('buy the dip now')));
  check('...nor does a post stuffed with hashtags', !(await has('airdrop')));

  console.log('\n[Settings → Nostr: the mute list, laid out and editable]');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => e.getAttribute('aria-label') === 'Settings'); b.click(); }); await sleep(600);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.settings-tile')].find((e) => [...e.querySelectorAll('span')].some((x) => x.textContent.trim() === 'Nostr')); if (b) b.click(); }); await sleep(800);
  check('the card lists the muted person and the hidden word and hashtag', await waitText('muted and hidden', 5000) && await page.evaluate(() => !!document.querySelector('.mod-person')) && await has('lasagna') && await has('#nsfw') && await has('1 muted thread'));
  await page.click('.mod-word'); await page.type('.mod-word', 'pineapple');
  await page.evaluate(() => { window.__published = []; });
  await page.keyboard.press('Enter'); await sleep(1500);
  const ml = (await page.evaluate(() => window.__published)).find((e) => e.kind === 10000);
  check('adding a word publishes the list with it, keeping the rest', !!ml && ml.tags.some((x) => x[0] === 'word' && x[1] === 'pineapple') && ml.tags.some((x) => x[0] === 'p' && x[1] === MUTED.pk) && ml.tags.some((x) => x[0] === 't' && x[1] === 'NSFW'), JSON.stringify(ml && ml.tags));
  check('...and it is on the card', await page.evaluate(() => [...document.querySelectorAll('.mod-chip')].some((c) => c.textContent.includes('pineapple'))));
  await page.evaluate(() => { window.__published = []; document.querySelector('.mod-person button').click(); }); await sleep(1500);
  const un = (await page.evaluate(() => window.__published)).find((e) => e.kind === 10000);
  check('Unmute publishes the list without them', !!un && !un.tags.some((x) => x[0] === 'p' && x[1] === MUTED.pk) && un.tags.some((x) => x[0] === 'word' && x[1] === 'pineapple'), JSON.stringify(un && un.tags));
  check('nobody muted now', await has('Nobody muted'));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ moderation: mutes everywhere, reports fold, spam hidden' : '\n❌ failed');
process.exit(ok ? 0 : 1);
