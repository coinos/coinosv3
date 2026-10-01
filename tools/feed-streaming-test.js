// Signed relay events must surface before EOSE and independently of slow media.
// Run: bun tools/feed-streaming-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildVerifyWorker } from '../build.js';
const sk = generateSecretKey(), author = getPublicKey(sk), now = Math.floor(Date.now() / 1000);
const signed = (content, at, tags = []) => finalizeEvent({ kind: 1, content, created_at: at, tags }, sk);
const seeded = Array.from({ length: 20 }, (_, i) => signed('Cached reading post ' + i + '. Some words to give each post space. '.repeat(4), now - 600 - i * 60));
const fast = signed('First ready streamed post', now);
const later = signed('Second ready streamed post with an older timestamp', now - 10);
const slow = signed('Slow photo streamed post https://media.example/held.png', now + 10);
const cachedSlow = signed('Cached photo still warming https://media.example/held.png', now - 600);
const forged = { ...signed('Invalid signature must never appear', now + 20), sig: '0'.repeat(128) };
const reply = signed('A reply must never appear in the feed', now + 20, [['e', fast.id, '', 'reply']]);
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf("const root = document.getElementById('app');"));
const entry = `
import { messagesFeature } from './src/features/messages.js';
${dom}
const author = ${JSON.stringify(author)}, seeded = location.search === '?empty' ? []
  : location.search === '?cached-media' ? ${JSON.stringify([cachedSlow, ...seeded.slice(1)])} : ${JSON.stringify(seeded)};
const ui = { screen: 'wallet', chatOpen: true, msgView: 'feed' };
const wallet = { xpub: 'test-wallet', loaded: true, nostrRelays: () => ['wss://known.example'],
  loadFeatureState: (k, d) => k === 'follows' ? { tags: [['p', author]], at: Date.now()/1000 }
    : k === 'feedNotes' ? seeded : k === 'profiles' ? { [author]: { name: 'Stream Author', t: Date.now() } } : d,
  saveFeatureState() {}, registerCacheExtension() {} };
let feature;
function render() { if (feature) morphChildren(document.querySelector('#app'), [feature.screenView(), feature.bottomNav()]); }
feature = messagesFeature({ h, ui, wallet, render, toast() {}, hook: () => null,
  brandHeader: () => h('div', { style: 'height:60px' }, 'Coinos') });
window.test = { feature, render };
render();
await feature.testBoot();
window.bootDone = true;
window.beginRefresh = () => { window.refreshDone = false; feature.testRefresh().then(() => { window.refreshDone = true; }); };
`;
const bundle = await Bun.build({ entrypoints: ['stream-test-entry'], target: 'browser', plugins: [{ name: 'stream-test', setup(build) {
  build.onResolve({ filter: /^stream-test-entry$/ }, () => ({ path: 'entry', namespace: 'stream-test' }));
  build.onLoad({ filter: /.*/, namespace: 'stream-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace("id: 'messages',", "id: 'messages', testBoot: () => feedNow().boot, testRefresh: () => refreshFeed({ force: true }, feedNow()), testMerge: (evs, newerThan) => mergeFeed(evs, { newerThan }, feedNow()),") }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const worker = await buildVerifyWorker({ minify: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const server = Bun.serve({ port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/verify-worker.js') return new Response(worker, { headers: { 'Content-Type': 'text/javascript' } });
  if (path.startsWith('/punks')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  async function visit(search = '', waitForBoot = true) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url() === 'https://media.example/held.png') { page.heldImage = r; return; }
      if (r.url().startsWith(server.url.origin) || r.url().startsWith('data:')) r.continue(); else r.abort();
    });
    await page.evaluateOnNewDocument(() => {
      const sockets = [];
      window.feedClosed = 0;
      class FakeSocket extends EventTarget {
        static OPEN = 1; static CLOSED = 3;
        constructor(url) {
          super(); this.url = url; this.readyState = 0; this.subs = new Map(); sockets.push(this);
          setTimeout(() => { this.readyState = 1; this.emit('open', new Event('open')); }, 0);
        }
        emit(type, event) { this.dispatchEvent(event); this['on' + type]?.(event); }
        message(data) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(data) })); }
        send(raw) {
          const m = JSON.parse(raw);
          if (m[0] === 'CLOSE') { if (this.subs.get(m[1])?.kinds?.includes(1)) window.feedClosed++; this.subs.delete(m[1]); return; }
          if (m[0] !== 'REQ') return;
          const f = m[2]; this.subs.set(m[1], f);
          if (!f.kinds?.includes(1) && !f.kinds?.includes(10002)) setTimeout(() => this.message(['EOSE', m[1]]), 0);
        }
        close() { this.readyState = 3; this.emit('close', new Event('close')); }
      }
      window.WebSocket = FakeSocket;
      window.deliver = (events) => {
        let count = 0;
        for (const ws of sockets) for (const [id, f] of ws.subs) {
          if (!f.kinds?.includes(1) || f.since || f.until) continue;
          for (const e of events) if ((!f.authors || f.authors.includes(e.pubkey))) { ws.message(['EVENT', id, e]); count++; }
        }
        return count;
      };
      window.endQueries = () => { for (const ws of sockets) for (const [id, f] of ws.subs) if (!f.since) ws.message(['EOSE', id]); };
      window.discoveryPending = () => sockets.some((ws) => [...ws.subs.values()].some((f) => f.kinds?.includes(10002)));
    });
    await page.goto(server.url.href + search, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.test);
    if (waitForBoot) await page.waitForFunction(() => window.bootDone);
    await page.evaluate(() => {
      window.refreshDone = false;
      window.test.feature.testRefresh().then(() => { window.refreshDone = true; });
    });
    await page.waitForFunction(() => window.discoveryPending());
    return page;
  }
  const row = (id) => `.notes-feed > [data-key="${id}"]`;
  const count = (page) => page.$eval('.feed-new-pill .n', (e) => Number(e.textContent));
  let page = await visit();
  const reading = seeded[5].id;
  await page.$eval(row(reading), (r) => scrollTo(0, scrollY + r.getBoundingClientRect().top - 100));
  const held = await page.$eval(row(reading), (r) => r.getBoundingClientRect().top);
  assert(await page.evaluate((evs) => window.deliver(evs), [slow, fast, forged, reply]) > 0);
  await page.waitForSelector(row(fast.id), { timeout: 2000 });
  assert.equal(await count(page), 1, 'ready post shows the pill before other posts finish');
  assert.equal(await page.evaluate(() => window.feedClosed), 0, 'post appears before relay EOSE');
  assert(await page.evaluate(() => !window.refreshDone && window.discoveryPending()), 'relay discovery cannot block known-relay posts');
  assert(!(await page.$(row(slow.id))), 'unresolved photo waits independently');
  assert(!(await page.$(row(forged.id))), 'bad signatures stay out');
  assert(!(await page.$(row(reply.id))), 'replies stay out');
  await page.evaluate((evs) => window.deliver(evs), [later, fast]);
  await page.waitForSelector(row(later.id), { timeout: 2000 });
  assert.equal(await count(page), 2, 'out-of-order posts count and duplicates do not');
  assert(Math.abs(await page.$eval(row(reading), (r) => r.getBoundingClientRect().top) - held) <= 1, 'streaming preserves reading position');
  assert(page.heldImage, 'slow media is being prepared');
  await page.heldImage.respond({ status: 200, contentType: 'image/png', body: png });
  await page.waitForSelector(row(slow.id), { timeout: 2000 });
  assert.equal(await count(page), 3);
  assert(await page.$eval(row(slow.id), (r) => { const img = r.querySelector('.note-img'); return img?.complete && img.naturalWidth > 0; }), 'photo is decoded when admitted');
  assert(Math.abs(await page.$eval(row(reading), (r) => r.getBoundingClientRect().top) - held) <= 1, 'late-ready post also preserves reading position');
  await page.evaluate(() => window.endQueries());
  await page.waitForFunction(() => window.refreshDone);
  assert.equal(await count(page), 3, 'query completion does not duplicate streamed posts');
  await page.close();

  page = await visit();
  const headerTop = await page.$eval('.chat-page > .row', (r) => r.getBoundingClientRect().top);
  await page.evaluate((evs) => window.deliver(evs), [fast, later]);
  await page.waitForFunction(() => document.querySelector('.feed-new-pill .n')?.textContent === '2', { timeout: 2000 });
  assert(!(await page.$(row(fast.id))), 'header-visible prepends wait for an explicit tap');
  assert.equal(await page.$eval('.chat-page > .row', (r) => r.getBoundingClientRect().top), headerTop);
  await page.evaluate(() => { scrollTo(0, 1); scrollTo(0, 0); });
  assert.equal(await count(page), 2, 'scrolling at the top does not clear deferred new posts');
  await page.click('.feed-new-pill');
  await page.waitForSelector(row(later.id));
  assert(await page.$eval(row(later.id), (r) => Math.abs(r.getBoundingClientRect().top - 8) <= 2), 'tap reveals the oldest ready new post');
  assert(!(await page.$('.feed-new-pill')));
  await page.evaluate(() => window.endQueries());
  await page.waitForFunction(() => window.refreshDone);
  await page.close();

  page = await visit('?empty');
  await page.evaluate((evs) => window.deliver(evs), [fast]);
  await page.waitForSelector(row(fast.id), { timeout: 2000 });
  assert(!(await page.$('.feed-new-pill')), 'first paint of an empty feed has no new-post notice');
  const newer = signed('Newer post arrives after the first row paints', now + 30);
  await page.evaluate((evs) => window.deliver(evs), [newer]);
  await page.waitForSelector('.feed-new-pill', { timeout: 2000 });
  assert.equal(await count(page), 1, 'a later newer post in an initially empty feed can be revealed');
  await page.click('.feed-new-pill');
  await page.waitForSelector(row(newer.id));
  await page.evaluate(() => window.endQueries());
  await page.waitForFunction(() => window.refreshDone);
  await page.close();

  page = await visit('?cached-media', false);
  await page.evaluate((evs) => window.deliver(evs), [fast]);
  await page.waitForSelector('.feed-new-pill', { timeout: 2000 });
  assert(await page.evaluate(() => !window.bootDone), 'new-post notice does not wait for cached media');
  await page.click('.feed-new-pill');
  await page.waitForSelector(row(fast.id));
  assert(await page.$eval(row(fast.id), (r) => r.classList.contains('note-fresh')), 'prepared new rows keep their stable presentation during cache warm-up');
  assert(page.heldImage);
  await page.heldImage.respond({ status: 200, contentType: 'image/png', body: png });
  await page.waitForFunction(() => window.bootDone);
  await page.evaluate(() => window.endQueries());
  await page.waitForFunction(() => window.refreshDone);
  await page.close();

  page = await visit();
  await page.evaluate(([evs, boundary]) => {
    window.batchDone = false;
    window.test.feature.testMerge(evs, boundary).then(() => { window.batchDone = true; });
  }, [[slow, fast], seeded[0].created_at]);
  await page.waitForSelector('.feed-new-pill', { timeout: 2000 });
  assert.equal(await count(page), 1, 'a ready post in a snapshot batch does not wait for another post’s media');
  assert(await page.evaluate(() => !window.batchDone));
  await page.click('.feed-new-pill');
  await page.waitForSelector(row(fast.id));
  assert(page.heldImage);
  await page.heldImage.respond({ status: 200, contentType: 'image/png', body: png });
  await page.waitForFunction(() => window.batchDone);
  await page.evaluate(() => window.endQueries());
  await page.waitForFunction(() => window.refreshDone);
  await page.close();
  assert.deepEqual(errors, []);
  console.log('✓ signed posts stream before EOSE/discovery/slow media; counts, duplicates, filtering, prepared photos, scroll anchors and header notice work');
} finally { await browser.close(); server.stop(true); }
