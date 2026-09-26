// Two things about a feed you leave and come back to.
//
// A backgrounded tab is frozen by the phone: timers stop and the relay
// sockets are cut, so every post made while you were away is simply missing
// and the feed sits there looking stale until you pull it down by hand. It
// catches up by itself now.
//
// And a post that lands while you are reading halfway down must not shove the
// page under your thumb. Prepared posts arrive above the viewport, and the
// notice takes you up to them when tapped.
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
  const path = new URL(req.url).pathname;
  if (path.startsWith('/punks')) return new Response(Bun.file('dist' + path));
  if (path === '/slow.png') {
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
          // A catch-up query (no since, no until) is answered from the queue
          // the test filled, ahead of the real relay's end-of-stream.
          if (!m[2].since && !m[2].until && (window.__catchup || []).length) {
            const evs = window.__catchup; window.__catchup = [];
            setTimeout(() => { for (const ev of evs) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], ev]) })); }, 0);
          }
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
  await click('to import'); await sleep(400);
  await page.waitForSelector('textarea');
  const mn = generateMnemonic(wordlist);
  await page.type('textarea', mn);
  await click('open wallet');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  await page.evaluate(([k, pk, ns]) => {
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', pk]], c: '', at: Math.floor(Date.now() / 1000) }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify(ns));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [pk]: { name: 'Test Author', t: Date.now() } }));
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
  const before = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.notes-feed > .row')].find((n) => n.getBoundingClientRect().bottom > 120);
    return { y: Math.round(window.scrollY), text: r.innerText.split('\n').find((l) => /post number/.test(l)), top: Math.round(r.getBoundingClientRect().top) };
  });
  check('...reading further down', before.y > 400, 'scrollY ' + before.y);

  // a brand new post lands on the live subscription
  const fresh = signed('BRAND NEW POST', 0);
  const delivered = await page.evaluate((ev) => window.__inject(ev), fresh);
  check('...a post really arrives on a live subscription', delivered > 0, delivered + ' socket(s)');
  // A post waits at the door for its author's face and its pictures (or the
  // loading deadline) before it goes in. This author is cached locally.
  await sleep(2600);
  const after = await page.evaluate((text) => {
    const r = [...document.querySelectorAll('.notes-feed > .row')].find((n) => n.innerText.includes(text));
    return { y: Math.round(window.scrollY), top: r ? Math.round(r.getBoundingClientRect().top) : null,
      pill: (document.querySelector('.feed-new-pill') || {}).textContent || '',
      inFeed: /BRAND NEW POST/.test(document.querySelector('.notes-feed')?.innerText || ''),
      first: (document.querySelector('.notes-feed > .row') || {}).innerText || '' };
  }, before.text);
  check('it goes into the feed at once, at the top', after.inFeed && /BRAND NEW POST/.test(after.first));
  check('...and the post you were reading has not moved', after.top === before.top, `top ${before.top} → ${after.top} (scrollY ${before.y} → ${after.y})`);
  check('...and a pill says it is up there', /1 new post/i.test(after.pill), after.pill || 'no pill');

  await page.evaluate(() => document.querySelector('.feed-new-pill').click());
  await sleep(600);
  const opened = await page.evaluate(() => ({ y: Math.round(window.scrollY), pill: !!document.querySelector('.feed-new-pill') }));
  check('tapping it takes you up to the post', opened.y < 120, 'scrollY ' + opened.y);
  check('...and the pill is done', !opened.pill);

  console.log('\n[scrolling back up on your own]');
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(400);
  await page.evaluate((ev) => window.__inject(ev), signed('ANOTHER ONE', 0));
  await sleep(2600);
  check('a pill again, the post already in', !!(await page.$('.feed-new-pill'))
    && /ANOTHER ONE/.test(await page.evaluate(() => document.querySelector('.notes-feed')?.innerText || '')));
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(900);
  check('...that reaching the top clears by itself', !(await page.$('.feed-new-pill')));

  console.log('\n[a post arrives whole, above the viewport]');
  // Move the first post to the viewport edge so a prepend is offscreen.
  await page.evaluate(() => {
    const first = document.querySelector('.notes-feed > .row');
    scrollBy(0, Math.ceil(first.getBoundingClientRect().top));
  });
  // The image is decoded before the row is admitted, with no height animation.
  await page.evaluate(() => {
    window.__firstSight = null;
    const feed = document.querySelector('.notes-feed');
    const look = () => {
      if (window.__firstSight) return;
      const row = [...feed.querySelectorAll('.row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
      if (!row) return;
      const img = row.querySelector('img.note-img');
      window.__firstSight = { img: !!img, ready: !!(img && img.complete && img.naturalWidth > 0), at: performance.now() };
      // a fresh <img> node reports complete a beat after it is inserted, even
      // from cache — what matters is that it is drawn on its first frame
      const t = performance.now();
      const poll = () => { if (img && img.complete && img.naturalWidth > 0) window.__firstSight.readyMs = Math.round(performance.now() - t); else if (performance.now() - t < 400) requestAnimationFrame(poll); };
      requestAnimationFrame(poll);
    };
    new MutationObserver(look).observe(feed, { childList: true, subtree: true });
  });
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate((ev) => window.__inject(ev), signed('PICTURE POST http://localhost:5296/slow.png?' + Date.now(), 0));
  const heldPictureAnchor = await page.evaluate(() => { const r = document.querySelector('.notes-feed > .row'); return { id: r.dataset.key, top: r.getBoundingClientRect().top }; });
  await page.waitForFunction(() => !!window.__firstSight, { timeout: 4000 }).catch(() => {});
  await sleep(120);
  const sight = await page.evaluate(() => window.__firstSight);
  check('the prepared post arrived above the reader', !!sight && sight.img && !!(await page.$('.feed-new-pill')), JSON.stringify(sight));
  check('...having waited for the slow host', !!sight && sight.at - t0 >= 700, sight ? Math.round(sight.at - t0) + 'ms' : '');
  const mid = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.notes-feed > .row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
    return row ? { anims: row.getAnimations().length, h: row.getBoundingClientRect().height } : null;
  });
  await sleep(600);
  const settled = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.notes-feed > .row')].find((n) => /PICTURE POST/.test(n.innerText || ''));
    return row ? { anims: row.getAnimations().length, h: row.getBoundingClientRect().height, overflow: row.style.overflow } : null;
  });
  check('...without animating its height', !!mid && !!settled && mid.anims === 0 && mid.h === settled.h
    && settled.anims === 0 && settled.h > 0 && !settled.overflow, JSON.stringify({ mid, settled }));
  check('...and the reading position is preserved', await page.evaluate(({ id, top }) => {
    const row = document.querySelector('.notes-feed > [data-key="' + id + '"]');
    return row && Math.abs(row.getBoundingClientRect().top - top) <= 1;
  }, heldPictureAnchor));
  // decoded before the row is inserted; the fresh <img> node reports it a
  // task later, so the row's first frames are what is checked here
  check('...and its picture was already decoded when the row appeared', !!sight && (sight.ready || sight.readyMs <= 60), JSON.stringify(sight));

  // ---- coming back: the app was hidden for a while, then focused again. The
  // catch-up re-asks the relays (force, past the throttle); the test answers.
  const away = async (makeQueue) => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(6500); // longer than the five seconds that count as a blink between apps
    const reqsBefore = await page.evaluate(() => window.__feedReqs || 0);
    const queue = makeQueue(); // signed now, after the wait: these are newer than everything on the page
    await page.evaluate((q) => {
      window.__catchup = q;
      
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, queue);
    await sleep(6500); // the catch-up settles once every relay has answered (5s at most)
    return { reqsBefore, reqsAfter: await page.evaluate(() => window.__feedReqs || 0) };
  };
  const label = (n) => n.innerText.split('\n').find((l) => /post number|NEW|ONE|POST|CATCH|TOP|AWAY/.test(l)) || n.innerText.slice(0, 40);
  const anchor = () => page.evaluate((label) => {
    const r = [...document.querySelectorAll('.notes-feed > .row')].find((n) => n.getBoundingClientRect().bottom > 120);
    return r ? { text: eval(label)(r), top: Math.round(r.getBoundingClientRect().top), y: Math.round(window.scrollY) } : null;
  }, label.toString());
  const rowAt = (text) => page.evaluate((label, text) => {
    const r = [...document.querySelectorAll('.notes-feed > .row')].find((n) => eval(label)(n) === text);
    return r ? { text, top: Math.round(r.getBoundingClientRect().top), y: Math.round(window.scrollY) } : null;
  }, label.toString(), text);
  const topRow = () => page.evaluate(() => (document.querySelector('.notes-feed > .row') || {}).innerText || '');

  console.log('\n[coming back after being away, a few new posts]');
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(500);
  const held = await anchor();
  // the notice keeps counting while the reader stays put: what matters is that it grew by three
  const pillN = () => page.evaluate(() => parseInt((document.querySelector('.feed-new-pill')?.textContent || '0').replace(/\D/g, ''), 10) || 0);
  const pillBefore = await pillN();
  const r1 = await away(() => [signed('CATCH-UP 1', 0), signed('CATCH-UP 2', 1), signed('CATCH-UP 3', 2),
    signed('an old post that was not in the cache', 5000), signed('another old one', 5100)]);
  check('coming back re-asks the relays without being told', r1.reqsAfter > r1.reqsBefore, `${r1.reqsBefore} → ${r1.reqsAfter} kind-1 requests`);
  const a1 = await rowAt(held.text);
  const feedText = () => page.evaluate(() => document.querySelector('.notes-feed')?.innerText || '');
  check('a few new posts go straight in', /CATCH-UP 1/.test(await feedText()));
  check('...and the pill says how many more are above you', (await pillN()) === pillBefore + 3, pillBefore + ' → ' + (await pillN()));
  check('...and the post you were reading has not moved', !!held && !!a1 && a1.text === held.text && Math.abs(a1.top - held.top) <= 2,
    JSON.stringify({ held, now: a1 }));
  // they sort below everything cached: page down to them
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(600);
  check('...older posts that merely missed the cache went in quietly too', /not in the cache/.test(await feedText()));
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  check('...scrolling up reaches the newest post, and clears the pill', /CATCH-UP 1/.test(await topRow()) && !(await page.$('.feed-new-pill')), (await topRow()).slice(0, 40));

  console.log('\n[coming back while sitting at the top]');
  const wasTop = await anchor();
  await away(() => [signed('AT-THE-TOP A', 0), signed('AT-THE-TOP B', 1)]);
  const a2 = await rowAt(wasTop.text);
  check('the header and first post stay in place', !!wasTop && !!a2 && a2.text === wasTop.text && Math.abs(a2.top - wasTop.top) <= 2 && a2.y === wasTop.y,
    JSON.stringify({ was: wasTop, now: a2 }));
  check('...new posts wait while the header is visible', !/AT-THE-TOP A/.test(await topRow()));
  await page.evaluate(() => {
    const first = document.querySelector('.notes-feed > .row');
    scrollBy(0, Math.ceil(first.getBoundingClientRect().top));
  });
  await sleep(600);
  check('...then arrive offscreen above it, with a notice', /AT-THE-TOP A/.test(await topRow()) && /2 new posts/i.test(await page.evaluate(() => document.querySelector('.feed-new-pill')?.textContent || '')));

  console.log('\n[coming back after a long time away]');
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(400);
  const heldLong = await anchor();
  // all in the same second — a post per second back would reach past the
  // top of the page after the thirteen seconds the two waits above took
  await away(() => Array.from({ length: 25 }, (_, i) => signed('LONG AWAY ' + (i + 1), 0)));
  const a3 = await rowAt(heldLong.text);
  check('many new posts still preserve the reading position', !!a3 && Math.abs(a3.top - heldLong.top) <= 2, JSON.stringify({ heldLong, a3 }));
  check('...with a notice', !!(await page.$('.feed-new-pill')));
  // the page top is not mounted from down here (windowing): go up to look
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(600);
  check('...and the newest posts at the top', /LONG AWAY 1\b/.test(await topRow()), (await topRow()).slice(0, 40));

  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the feed keeps up, without moving the page' : '\n❌ failed');
process.exit(ok ? 0 : 1);
