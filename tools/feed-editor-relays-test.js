// The new-feed form: its Back closes it (it used to send the page back
// behind the feed and leave the form up), and it can make a firehose —
// every post on the relays you name — as a saved feed.
// Run: bun tools/feed-editor-relays-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
// record what the page asks which relay, without letting it publish anything
await page.evaluateOnNewDocument(() => {
  window.__reqs = [];
  const Real = window.WebSocket;
  window.WebSocket = function (url, ...a) {
    const ws = new Real(url, ...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try { const m = JSON.parse(data); if (m[0] === 'REQ') window.__reqs.push({ url: String(url), filters: m.slice(2) }); if (m[0] === 'EVENT') return; } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype; Object.assign(window.WebSocket, Real);
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const text = () => page.evaluate(() => document.body.innerText);
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  await click('create a new wallet'); await sleep(500); await click('to import'); await sleep(400);
  await page.waitForSelector('textarea'); await page.type('textarea', generateMnemonic(wordlist)); await click('open wallet');
  await waitFor(() => /receive/i.test(document.body.innerText), 20000);
  await page.click('[aria-label="Feed"]');
  await page.waitForSelector('.feed-chip.add', { timeout: 15000 });

  // Back closes the form and leaves the feed where it was
  await page.click('.feed-chip.add'); await sleep(400);
  check('the + chip opens the new-feed form', !!(await page.$('.feed-relays-input')));
  await page.click('.chat-back'); await sleep(600);
  check("the form's Back closes it", !(await page.$('.feed-relays-input')));
  check('...back on the feed, not some page behind it', await page.evaluate(() => history.state?.nav?.msgView === 'feed' && !!document.querySelector('.feed-chip.add')));
  await page.click('.feed-chip.add'); await sleep(400);
  await page.goBack(); await sleep(600);
  check('the browser Back closes it too', !(await page.$('.feed-relays-input')) && !!(await page.$('.feed-chip.add')));

  // a firehose from one relay
  await page.click('.feed-chip.add'); await sleep(400);
  check('the people/packs/topics sections are there before the firehose is ticked', /people/i.test(await text()) && /topics/i.test(await text()));
  await page.type('.feed-relays-input', 'nos.lol');
  await page.click('.feed-all-toggle'); await sleep(200);
  check('ticking "every post" hides what a firehose does not need', !/add a person/i.test(await text()) && !(await page.$('input[placeholder*="#"]')));
  await page.evaluate(() => { window.__reqs = []; });
  await click('save'); await sleep(2500);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.feed-chip')].map((c) => (c.classList.contains('on') ? '*' : '') + c.textContent.trim()));
  check('saved as a feed named after its relay, and opened', chips.includes('*nos.lol'), JSON.stringify(chips));
  const asks = await page.evaluate(() => window.__reqs.filter((r) => r.filters.some((f) => (f.kinds || []).includes(1) && !f.authors && !f['#t'] && !f.ids && !f['#e'])));
  // (names, reactions and replies for what it shows are still asked about on the usual relays)
  check('it asks nos.lol for every post, no authors or topics', asks.some((r) => /nos\.lol/.test(r.url)), JSON.stringify(asks.map((r) => r.url)));
  check('...and asks no other relay for the posts themselves', asks.length > 0 && asks.every((r) => /nos\.lol/.test(r.url)), JSON.stringify([...new Set(asks.map((r) => r.url))]));

  // a firehose needs relays
  await page.click('.feed-chip.add'); await sleep(400);
  await page.click('.feed-all-toggle'); await sleep(200);
  await click('save'); await sleep(400);
  check('a firehose with no relays is refused, with a reason', !!(await page.$('.feed-relays-input')) && /name the relays/i.test(await text()));
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  check('run completed', false, e.stack);
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ the feed form: Back works, and relays make a firehose' : '\n❌ failures above');
process.exit(ok ? 0 : 1);
