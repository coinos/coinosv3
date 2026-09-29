// Polls (NIP-88, kind 1068): shown as their options with each one's share of
// the vote (kind 1018), votable from the feed and the thread, and pictured
// in a quote card. Uses a real poll from the relays; outgoing votes are
// caught at the socket so the test never votes on someone's real poll.
//
// Run: bun tools/poll-test.js
import puppeteer from 'puppeteer-core';
import { SimplePool } from 'nostr-tools/pool';
import { cacheKeyFor } from '../src/wallet.js';
import { neventOf } from '../src/nostr.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const POLL_ID = '000002f7c6a38223a9843d6e93ce8c15a3048bc95003690d74341cf9de372bfc';
const pool = new SimplePool();
const [poll] = await pool.querySync(['wss://relay.coinos.io', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'], { ids: [POLL_ID] }, { maxWait: 6000 });
if (!poll) { console.log(' ✗ the poll is not on the relays'); process.exit(1); }
const labels = poll.tags.filter((x) => x[0] === 'option').map((x) => x[2]);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5273, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__votes = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (typeof d === 'string' && d.startsWith('["EVENT"') && /"kind":1018\b/.test(d)) { window.__votes.push(JSON.parse(d)[1]); return; }
    return send.call(this, d);
  };
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5273/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  const Q = 'a'.repeat(63) + '9';
  await page.evaluate(([k, poll, q, ref]) => {
    const now = Math.floor(Date.now() / 1000);
    const quoting = { id: 'd'.repeat(64), pubkey: q, kind: 1, created_at: now, content: 'vote on this nostr:' + ref, tags: [] };
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', poll.pubkey], ['p', q]], c: '', at: now }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify([quoting, poll]));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [poll.pubkey]: { name: 'Poll Author', t: Date.now() }, [q]: { name: 'Quoter', t: Date.now() } }));
  }, [base, poll, Q, neventOf(poll.id, poll.pubkey)]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => document.querySelector('.app-bottom-nav .app-nav-button').click());
  await waitFor(() => document.querySelectorAll('.notes-feed .poll').length >= 2, 20000);

  const feedPoll = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.notes-feed [data-key]')].find((r) => r.querySelector(':scope .poll button.poll-opt'));
    return row && { opts: [...row.querySelectorAll('.poll-opt .poll-label')].map((n) => n.textContent), text: row.innerText };
  });
  check('a poll in the feed shows its options', !!feedPoll && JSON.stringify(feedPoll.opts) === JSON.stringify(labels), JSON.stringify(feedPoll?.opts));
  check('...and not the "doesn’t show" placeholder', !(await page.evaluate(() => document.body.innerText.includes('doesn’t show'))));
  check('its votes come in from the relays', await waitFor(() => /\d+ votes?/.test(document.querySelector('.notes-feed .poll-foot')?.textContent || ''), 15000),
    await page.evaluate(() => document.querySelector('.notes-feed .poll-foot')?.textContent));
  const quoted = await page.evaluate(() => { const q = document.querySelector('.quote-card .poll'); return q && { n: q.querySelectorAll('.poll-opt.static').length, buttons: q.querySelectorAll('button').length }; });
  check('a quoted poll is pictured in its card, not votable there', !!quoted && quoted.n === labels.length && quoted.buttons === 0, JSON.stringify(quoted));

  // vote for the last option from the feed
  const before = await page.evaluate(() => location.href);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.notes-feed button.poll-opt')].pop(); b.click(); });
  await waitFor(() => window.__votes.length > 0, 10000);
  const vote = await page.evaluate(() => window.__votes[0]);
  const lastId = poll.tags.filter((x) => x[0] === 'option').pop()[1];
  check('tapping an option publishes a kind 1018 vote for it', vote && vote.kind === 1018
    && vote.tags.some((x) => x[0] === 'e' && x[1] === poll.id) && vote.tags.filter((x) => x[0] === 'response').map((x) => x[1]).join() === lastId,
    JSON.stringify(vote?.tags));
  check('...marked as mine at once', await waitFor(() => !!document.querySelector('.notes-feed button.poll-opt.mine'), 3000));
  check('...without opening the thread', (await page.evaluate(() => location.href)) === before);

  // the thread: the poll as its root
  await page.evaluate(() => { const r = [...document.querySelectorAll('.notes-feed [data-key]')].find((n) => n.querySelector(':scope .poll button.poll-opt')); r.querySelector('.note-text').click(); });
  check('the poll opens as a thread', await waitFor(() => !!document.querySelector('.thread-page .poll button.poll-opt'), 10000));
  check('...still showing my vote', await page.evaluate(() => !!document.querySelector('.thread-page .poll-opt.mine')));
  if (process.env.SHOT) { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500); await page.screenshot({ path: process.env.SHOT }); }
  check('...with its replies', await waitFor(() => document.querySelectorAll('.thread-page [data-zap-post]').length > 1, 15000));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ polls read and vote' : '\n❌ failed');
process.exit(ok ? 0 : 1);
