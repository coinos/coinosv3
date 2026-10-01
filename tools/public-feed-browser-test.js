import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { buildHtml, buildVerifyWorker } from '../build.js';
const sk = generateSecretKey(), now = Math.floor(Date.now() / 1000);
const note = finalizeEvent({ kind: 1, created_at: now, tags: [], content: 'This is the shared public snapshot for everyone to read. https://slow.example/photo.png' }, sk);
const profile = finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Snapshot Author', picture: 'https://slow.example/avatar.png' }) }, sk);
const html = await buildHtml({ minify: true, pwa: false });
const worker = await buildVerifyWorker({ minify: true });
let mode = 'ok', requests = 0;
const server = Bun.serve({ port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/feed') {
    requests++;
    if (mode === 'unavailable') return new Response(null, { status: 503 });
    return Response.json({ version: 1, generatedAt: Date.now(), popUntil: now - 100,
      notes: [mode === 'corrupt' ? { ...note, content: 'Forged snapshot content' } : note], profiles: [profile] });
  }
  if (path === '/verify-worker.js') return new Response(worker, { headers: { 'Content-Type': 'text/javascript' } });
  if (path.startsWith('/punks')) return new Response(null, { status: 404 });
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
try {
  async function visit(path) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      // Leave media unresolved: first paint must not depend on its timeout.
      if (r.url().startsWith('https://slow.example/')) return;
      return r.url().startsWith(server.url.origin) || r.url().startsWith('data:') ? r.continue() : r.abort();
    });
    await page.evaluateOnNewDocument(() => {
      window.relayFilters = [];
      class FakeSocket extends EventTarget {
        static OPEN = 1; static CLOSED = 3;
        readyState = 0;
        constructor() { super(); setTimeout(() => { this.readyState = 1; this.onopen?.({}); this.dispatchEvent(new Event('open')); }, 0); }
        send(data) {
          const m = JSON.parse(data);
          if (m[0] === 'REQ') {
            window.relayFilters.push(m[2]);
            setTimeout(() => { const e = new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }); this.onmessage?.(e); this.dispatchEvent(e); }, 0);
          }
        }
        close() { this.readyState = 3; this.onclose?.({}); }
      }
      window.WebSocket = FakeSocket;
    });
    await page.goto(server.url.origin + path);
    return page;
  }
  let page = await visit('/feed');
  await page.waitForFunction(() => document.body.innerText.includes('This is the shared public snapshot'), { timeout: 2500 });
  assert.equal(await page.$eval('.notes-feed', (el) => el.dataset.booting), '1', 'posts render while slow media is still warming');
  assert((await page.evaluate(() => document.body.innerText)).includes('Snapshot Author'));
  assert.equal(await page.evaluate(() => window.relayFilters.filter((f) => f.kinds?.includes(7)).length), 0);
  await page.close();
  for (const state of ['corrupt', 'unavailable']) {
    mode = state;
    page = await visit('/feed');
    await page.waitForFunction(() => window.relayFilters.some((f) => f.kinds?.includes(7)), { timeout: 15000 });
    assert(!(await page.evaluate(() => document.body.innerText)).includes('Forged snapshot content'));
    await page.close();
  }
  const before = requests;
  page = await visit('/feed?r=wss://custom.example');
  await page.waitForFunction(() => window.relayFilters.some((f) => f.kinds?.includes(7)), { timeout: 15000 });
  assert.equal(requests, before, 'custom relays bypass snapshot');
  await page.close();
  console.log('✓ browser renders signed snapshot/profile before slow media and without reaction scans; corrupt/unavailable snapshots fall back; custom relays bypass cache');
} finally {
  await browser.close();
  server.stop(true);
}
