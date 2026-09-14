// Two things about a feed you leave and come back to.
//
// A backgrounded tab is frozen by the phone: timers stop and the relay
// sockets are cut, so every post made while you were away is simply missing
// and the feed sits there looking stale until you pull it down by hand. It
// catches up by itself now.
//
// And a post that lands while you are reading halfway down must not shove the
// page under your thumb. It waits behind a pill that says how many, and the
// tap that shows them takes you up to them.
//
// Run: bun tools/feed-live-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

// A real key, because a post arriving on a subscription is signature-checked
// on the way in — an unsigned fake would be dropped and prove nothing.
const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const signed = (content, ago) => finalizeEvent(
  { kind: 1, created_at: Math.floor(Date.now() / 1000) - ago, tags: [], content }, SK);
// enough to scroll past; these ride in through the cache, which is trusted
const seeded = Array.from({ length: 25 }, (_, i) => signed('post number ' + (i + 1), 600 + i * 60));

const html = await buildHtml({ minify: true, pwa: false });
// a picture that takes its time, so a post showing it must have waited
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const server = Bun.serve({ port: 5296, fetch: async (req) => {
  if (new URL(req.url).pathname === '/slow.png') {
    await sleep(700);
    return new Response(PNG, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  }
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__feedReqs = 0;
  const subs = []; // [socket, subId] for every open kind-1 subscription
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2] && Array.isArray(m[2].kinds) && m[2].kinds.includes(1)) {
          window.__feedReqs++;
          subs.push([ws, m[1]]);
        }
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
  // Hand a real event to the app exactly as a relay would: down an open
  // subscription, through the signature gate, into mergeFeed.
  window.__inject = (ev) => {
    let n = 0;
    for (const [ws, id] of subs) {
      if (ws.readyState !== 1) continue;
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', id, ev]) }));
      n++;
    }
    return n;
  };
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5296/', { waitUntil: 'domcontentloaded' });
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
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
  }, [base, AUTHOR, seeded]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => /message/i.test(e.getAttribute('aria-label') || '')); if (b) b.click(); });
  await sleep(1000);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.item')].find((n) => /feed/i.test(n.textContent)); if (e) e.click(); });
  await sleep(4000);
  check('the feed has posts in it', (await page.evaluate(() => document.querySelectorAll('.notes-feed > .row').length)) > 0);

  console.log('\n[a post arriving while you read]');
  // scroll down: this is someone reading, not someone sitting at the top
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(500);
  const before = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    first: (document.querySelector('.notes-feed > .row') || {}).innerText || '',
  }));
  check('...reading further down', before.y > 400, 'scrollY ' + before.y);

  // a brand new post lands on the live subscription
  const fresh = signed('BRAND NEW POST', 0);
  const delivered = await page.evaluate((ev) => window.__inject(ev), fresh);
  check('...a post really arrives on a live subscription', delivered > 0, delivered + ' socket(s)');
  // A post waits at the door for its author's face and its pictures (or the
  // two-second deadline, for a face nobody has) before it is even counted —
  // so give it that long, and no longer.
  await sleep(2600);
  const after = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    pill: (document.querySelector('.feed-new-pill') || {}).textContent || '',
    inFeed: /BRAND NEW POST/.test(document.querySelector('.notes-feed')?.innerText || ''),
  }));
  check('it does not shove itself into the page', !after.inFeed);
  check('...it says so in a pill instead', /1 new post/i.test(after.pill), after.pill || 'no pill');
  check('...and the page has not moved under you', Math.abs(after.y - before.y) < 40,
    `scrollY ${before.y} → ${after.y}`);

  await page.evaluate(() => document.querySelector('.feed-new-pill').click());
  await sleep(1400);
  const opened = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    inFeed: /BRAND NEW POST/.test(document.querySelector('.notes-feed')?.innerText || ''),
    pill: !!document.querySelector('.feed-new-pill'),
  }));
  check('tapping it shows the post', opened.inFeed);
  check('...and takes you up to it', opened.y < 120, 'scrollY ' + opened.y);
  check('...and the pill is done', !opened.pill);

  console.log('\n[scrolling back up on your own]');
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(400);
  await page.evaluate((ev) => window.__inject(ev), signed('ANOTHER ONE', 0));
  await sleep(800);
  check('a pill again', !!(await page.$('.feed-new-pill')));
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(900);
  check('...and scrolling to the top lets it in by itself',
    await page.evaluate(() => /ANOTHER ONE/.test(document.querySelector('.notes-feed')?.innerText || '')
      && !document.querySelector('.feed-new-pill')));

  console.log('\n[a post arrives whole]');
  // A row used to paint first and fill in its picture after. Watch the feed
  // from the instant the post is injected: the first time the row exists,
  // its image must already be decoded.
  await page.evaluate(() => {
    window.__firstSight = null;
    const feed = document.querySelector('.notes-feed');
    const look = () => {
      if (window.__firstSight) return;
      const row = [...feed.querySelectorAll('.row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
      if (!row) return;
      const img = row.querySelector('img.note-img');
      window.__firstSight = { img: !!img, ready: !!(img && img.complete && img.naturalWidth > 0), at: performance.now() };
    };
    new MutationObserver(look).observe(feed, { childList: true, subtree: true });
  });
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate((ev) => window.__inject(ev), signed('PICTURE POST http://localhost:5296/slow.png?' + Date.now(), 0));
  await page.waitForFunction(() => !!window.__firstSight, { timeout: 4000 }).catch(() => {});
  await sleep(120); // a hair in: the animation has been started and not finished
  const sight = await page.evaluate(() => window.__firstSight);
  check('the post is in the feed', !!sight && sight.img, JSON.stringify(sight));
  // ...and it opened rather than appeared: caught mid-animation, shorter
  // than it will be, and full height once the animation is done
  const mid = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.notes-feed > .row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
    return row ? { anims: row.getAnimations().length, h: row.getBoundingClientRect().height } : null;
  });
  await sleep(600);
  const settled = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.notes-feed > .row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
    return row ? { anims: row.getAnimations().length, h: row.getBoundingClientRect().height, overflow: row.style.overflow } : null;
  });
  check('...and it opened rather than appeared', !!mid && !!settled && mid.anims > 0 && mid.h < settled.h
    && settled.anims === 0 && settled.h > 0 && !settled.overflow, JSON.stringify({ mid, settled }));
  check('...and its picture was already decoded the first time the row existed', !!sight && sight.ready);
  check('...having waited for the slow host', !!sight && sight.at - t0 >= 700, sight ? Math.round(sight.at - t0) + 'ms' : '');

  console.log('\n[coming back after being away]');
  // the throttle would otherwise swallow a refresh this soon after the last
  // the app was hidden for a while, then focused again
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // longer than the five seconds that count as a blink between apps
  await sleep(6500);
  const reqsBefore = await page.evaluate(() => window.__feedReqs || 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(3500);
  const reqsAfter = await page.evaluate(() => window.__feedReqs || 0);
  check('coming back re-asks the relays without being told',
    reqsAfter > reqsBefore, `${reqsBefore} → ${reqsAfter} kind-1 requests`);

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the feed keeps up, without moving the page' : '\n❌ failed');
process.exit(ok ? 0 : 1);
