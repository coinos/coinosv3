// A shared /nevent1… link: the server renders the thread into the page, and
// the app paints it — author's name and face included — on its first frame,
// with no relay answering at all. No flash of the front door on the way, and
// no Back button inventing a parent the visitor never came from.
// Run: bun tools/note-page-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { neventEncode } from 'nostr-tools/nip19';
import { parseNoteRef, buildThread, createThreadCache, renderNotePage } from '../feed/note-page.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, fn) => Promise.resolve(fn()).then(() => console.log('✓ ' + name));

const A = generateSecretKey(), B = generateSecretKey();
const now = Math.floor(Date.now() / 1000);
const root = finalizeEvent({ kind: 1, created_at: now - 600, tags: [], content: 'Where do you mostly use Nostr? </script><b>not markup</b>' }, A);
const reply = finalizeEvent({ kind: 1, created_at: now - 300, tags: [['e', root.id, '', 'root'], ['p', getPublicKey(A)]], content: 'Mostly away from home' }, B);
const kind0 = (sk, name) => finalizeEvent({ kind: 0, created_at: now - 9000, tags: [], content: JSON.stringify({ name, picture: 'https://example.invalid/' + name + '.png' }) }, sk);
const events = [root, reply, kind0(A, 'Josh'), kind0(B, 'Rae')];
// a relay pool's answer to one filter
const match = (f) => events.filter((e) => (!f.ids || f.ids.includes(e.id)) && (!f.kinds || f.kinds.includes(e.kind))
  && (!f.authors || f.authors.includes(e.pubkey)) && (!f['#e'] || e.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1]))));
const fakeQuery = async (relays, f) => match(f);

const path = neventEncode({ id: reply.id, author: getPublicKey(B), relays: ['wss://relay.example.invalid'] });
const ref = parseNoteRef('/' + path);
await check('nevent paths parse; other paths do not', () => {
  assert.equal(ref.id, reply.id);
  assert.deepEqual(ref.relays, ['wss://relay.example.invalid']);
  assert.equal(parseNoteRef('/asoltys'), null);
  assert.equal(parseNoteRef('/nevent1garbage'), null);
});
const data = await buildThread(ref, fakeQuery);
await check('a reply is served with its root, the replies and both faces', () => {
  assert.equal(data.root.id, root.id);
  assert.deepEqual(data.replies.map((e) => e.id), [reply.id]);
  assert.deepEqual(data.profiles.map((e) => JSON.parse(e.content).name).sort(), ['Josh', 'Rae']);
});
await check('a reply whose root is nowhere is left to the client', async () => {
  const orphan = finalizeEvent({ kind: 1, created_at: now, tags: [['e', 'f'.repeat(64), '', 'root']], content: 'lost' }, B);
  assert.equal(await buildThread({ id: orphan.id, relays: [] }, async (r, f) => (f.ids?.includes(orphan.id) ? [orphan] : [])), null);
});
await check('a slow thread misses the budget, then serves the next visitor', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const cache = createThreadCache({ build: async () => { await gate; return data; } });
  assert.equal(await cache.get(ref, 50), null);
  release();
  await sleep(10);
  assert.equal(await cache.get(ref, 50), data);
});
const html = await buildHtml({ minify: true, pwa: false });
const page1 = renderNotePage(html, data, { ...ref, path }, 'https://v3.coinos.io');
await check('preview tags name the author and escape the post', () => {
  assert.match(page1, /<title>Rae on Coinos<\/title>/);
  assert.match(page1, /<meta property="og:description" content="Mostly away from home">/);
  // the root's text sits inside the JSON script; it can't close the tag
  const json = page1.slice(page1.indexOf('id="boot-thread">'));
  assert(!json.slice(0, json.indexOf('</script>')).includes('</script'), 'no closing tag inside the JSON');
});

// The browser: relays are blackholed, so whatever paints came from the page.
const server = Bun.serve({ port: 0, fetch: (req) => {
  const u = new URL(req.url), p = u.pathname;
  if (p.startsWith('/punks') || p === '/verify-worker.js') return new Response(Bun.file('dist' + p));
  if (p === '/' + path && !u.searchParams.has('plain')) return new Response(page1, { headers: { 'content-type': 'text/html' } });
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
try {
  const open = async (url) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = function () { const ws = new EventTarget(); ws.readyState = 0; ws.send = () => {}; ws.close = () => {}; return ws; };
      window.__frames = [];
      const tick = () => { try { if (document.body) window.__frames.push(document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)); } catch {} };
      setInterval(tick, 16);
    });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { page, errs };
  };
  const { page, errs } = await open(server.url.href + path);
  await page.waitForFunction(() => /Mostly away from home/.test(document.body.innerText), { timeout: 8000 });
  await sleep(600);
  const frames = await page.evaluate(() => window.__frames);
  await check('the thread opens from the page alone, names and all', async () => {
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /Rae/);
    assert.match(text, /Josh/);
    assert.match(text, /Where do you mostly use Nostr\? <\/script><b>not markup<\/b>/);
  });
  await check('never the front door on the way', () => {
    const door = frames.find((f) => /Create a new wallet|Welcome to coinos/i.test(f));
    assert(!door, 'front door painted: ' + door);
  });
  await check('opened straight from a link: no Back button', async () => {
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.thread-page button')].some((b) => b.textContent.trim() === 'Back')), false);
  });
  await check('no page errors', () => assert.deepEqual(errs, []));
  await page.close();

  // Without the server's help (plain index.html): a pending frame, not the
  // front door, while the relays (here: none) are asked.
  const plain = await open(server.url.href + path + '?plain');
  await sleep(1500);
  const pf = await plain.page.evaluate(() => window.__frames);
  await check('a plain page holds a "Fetching note" frame instead of the front door', () => {
    const before = pf.slice(0, pf.findIndex((f) => /Fetching note/i.test(f)) + 1);
    assert(pf.some((f) => /Fetching note/i.test(f)), 'no pending frame: ' + pf.at(-1));
    assert(!before.some((f) => /Create a new wallet|Welcome to coinos/i.test(f)), 'front door before the pending frame');
  });
  await plain.page.close();
} finally { await browser.close(); server.stop(true); }
console.log('\n✅ note pages');
process.exit(0);
