// NIP-22 comments (kind 1111): a thread rooted in something other than a
// kind 1 note (here a real long-form article, kind 30023) shows its
// comments, and a reply to it — or to one of its comments — goes out as a
// kind 1111 with the root's E/K/P and the parent's e/k/p. Outgoing events
// are caught at the socket; nothing is published.
//
// Run: bun tools/comments-test.js
import puppeteer from 'puppeteer-core';
import { SimplePool } from 'nostr-tools/pool';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const ROOT = 'b615961519481cffc69af3e6ba9ae45fc236c251f21d327d243804dc94a77026';
const NEVENT = 'nevent1qvzqqqr4gupzq0mhp4ja8fmy48zuk5p6uy37vtk8tx9dqdwcxm32sy8nsaa8gkeyqqstv9vkz5v5s88lc6d08e46ntj9ls3kcfgly8fj05jrspxujjnhqfsede0ss';
const pool = new SimplePool();
const R = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostr.wine'];
let root = null, comments = [];
for (let i = 0; i < 3 && !(root && comments.length); i++) {
  root ||= (await pool.querySync(R, { ids: [ROOT] }, { maxWait: 8000 }))[0];
  if (!comments.length) comments = await pool.querySync(R, { kinds: [1111], '#E': [ROOT] }, { maxWait: 5000 });
}
if (!root || !comments.length) { console.log(' ✗ the article or its comments are gone from the relays', !!root, comments.length); process.exit(1); }
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5283, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__sent = [];
  window.__all = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    window.__all.push(this.url + ' ' + String(d).slice(0, 60));
    if (typeof d === 'string' && d.startsWith('["EVENT"')) { // every event: nothing leaves the test
      const ev = JSON.parse(d)[1];
      window.__sent.push(ev);
      // answer as a relay would, so the app counts it published
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['OK', ev.id, true, '']) })), 50);
      return;
    }
    return send.call(this, d);
  };
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
const reply = async (rowFind, text) => {
  await page.evaluate((f) => { const row = new Function('return ' + f)()(); row.querySelector('button[aria-label="Reply"]').click(); }, rowFind.toString());
  await waitFor(() => !!document.querySelector('.thread-reply-input'), 5000);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + text.length + '.png' });
  await page.focus('.thread-reply-input');
  await page.keyboard.type(text);
  if (process.env.DBG) console.log('typed:', await page.evaluate(() => ({ boxes: document.querySelectorAll('.thread-reply-input').length, v: document.querySelector('.thread-reply-input')?.value, sendDisabled: document.querySelector('.thread-reply-send')?.disabled, active: document.activeElement?.className })));
  await page.evaluate(() => document.querySelector('.thread-reply-send').click());
  await sleep(300);
  if (process.env.DBG && text.startsWith('a reply')) console.log('ALL', await page.evaluate(() => window.__all.slice(-25)));
  if (process.env.DBG) console.log('after send:', await page.evaluate(() => ({ boxes: document.querySelectorAll('.thread-reply-input').length, toast: document.querySelector('.toast.show')?.textContent })));
  // one event per relay it goes to: pick the one carrying this text
  const mine = 'return window.__sent.find((e) => e.content.endsWith(' + JSON.stringify(text) + '))';
  await waitFor(new Function('return !!(() => { ' + mine + ' })()'), 20000);
  return page.evaluate(new Function(mine));
};
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5283/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  await click('skip verification');
  await waitText('receive', 20000);
  await page.goto('http://localhost:5283/' + NEVENT, { waitUntil: 'domcontentloaded' });
  const first = comments.sort((a, b) => a.created_at - b.created_at)[0];
  const shown = await waitFor(new Function('return document.querySelector(".thread-page")?.innerText.includes(' + JSON.stringify(first.content.slice(0, 20)) + ')'), 25000);
  check('the article opens with its NIP-22 comments', shown, JSON.stringify(first.content.slice(0, 40)));
  const rows = await page.evaluate(() => document.querySelectorAll('.thread-page [data-zap-post]').length);
  check('...each as a row of the thread', rows >= 1 + Math.min(comments.length, 2), rows + ' rows for ' + comments.length + ' comments');

  const ev = await reply(() => document.querySelector('.thread-page [data-zap-post]'), 'a comment on the article');
  const tag = (e, n) => (e?.tags || []).filter((x) => x[0] === n).map((x) => x[1]);
  check('a reply to the article is a kind 1111 comment', ev?.kind === 1111, 'kind ' + ev?.kind);
  check('...with the root as E/K/P', tag(ev, 'E')[0] === ROOT && tag(ev, 'K')[0] === '30023' && tag(ev, 'P')[0] === root.pubkey, JSON.stringify(ev?.tags));
  check('...and its address as A', tag(ev, 'A')[0] === '30023:' + root.pubkey + ':' + tag(root, 'd')[0]);
  check('...and the article as the parent (e/k/p)', tag(ev, 'e')[0] === ROOT && tag(ev, 'k')[0] === '30023' && tag(ev, 'p')[0] === root.pubkey);

  await page.evaluate(() => document.querySelector('.thread-reply-cancel')?.click());
  const onScreen = await page.evaluate(() => [...document.querySelectorAll('.thread-page [data-zap-post]')].filter((r) => r.querySelector('button[aria-label="Reply"]')).map((r) => r.getAttribute('data-zap-post')));
  const target = comments.find((c) => onScreen.includes(c.id));
  if (process.env.DBG) console.log('rows with Reply', onScreen.length, 'comments', comments.map((c) => c.id.slice(0, 8)), 'shown', onScreen.map((x) => x.slice(0, 8)));
  const cid = target?.id;
  const ev2 = await reply(new Function('return () => document.querySelector(\'.thread-page [data-zap-post="' + cid + '"]\')')(), 'a reply to a comment');
  if (process.env.DBG) console.log(await page.evaluate((cid) => ({ sent: window.__sent.map((e) => e.kind + ':' + e.content.slice(0, 30)), row: !!document.querySelector('.thread-page [data-zap-post="' + cid + '"]'), box: document.querySelector('.thread-reply-input')?.value, toast: document.querySelector('.toast')?.textContent, sending: !!document.querySelector('.thread-reply-send .spinner') }), cid));
  if (process.env.DBG) console.log('EV2', JSON.stringify(ev2)?.slice(0, 200), await page.evaluate(() => window.__sent.filter((e) => e.kind === 1111).map((e) => JSON.stringify(e.content))));
  check('a reply to a comment is a kind 1111 too', ev2?.kind === 1111 && tag(ev2, 'E')[0] === ROOT, 'kind ' + ev2?.kind);
  check('...its parent the comment (e/k/p)', tag(ev2, 'e')[0] === cid && tag(ev2, 'k')[0] === '1111' && tag(ev2, 'p')[0] === target?.pubkey, JSON.stringify(ev2?.tags.filter((x) => /^[ekp]$/.test(x[0]))));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ comments read and write as NIP-22' : '\n❌ failed');
process.exit(ok ? 0 : 1);
