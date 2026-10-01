// Each post's reply button carries the number of replies the relays know.
// Run: bun tools/reply-count-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sk = generateSecretKey(), now = Math.floor(Date.now() / 1000);
const notes = Array.from({ length: 40 }, (_, i) => finalizeEvent({ kind: 1, created_at: now - 60 - i * 60, tags: [],
  content: `Post number ${i}. I walked down to the harbour this morning and watched the boats come in while the coffee went cold in my hands.` }, sk));
const replier = generateSecretKey();
const reply = (target, n, tags) => finalizeEvent({ kind: 1, created_at: now - 30 + n, content: 'Reply ' + n, tags }, replier);
// post 0: two NIP-10 replies and a nested one (its root counts all three);
// post 1: one positional reply and a quote that is not a reply
const r1 = reply(notes[0], 1, [['e', notes[0].id, '', 'root']]);
const replies = [r1, reply(notes[0], 2, [['e', notes[0].id, '', 'root']]),
  reply(notes[0], 3, [['e', notes[0].id, '', 'root'], ['e', r1.id, '', 'reply']]),
  reply(notes[1], 4, [['e', notes[1].id]]),
  reply(notes[1], 5, [['e', notes[1].id, '', 'mention']])];
const profile = finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Poster' }) }, sk);
const html = await buildHtml({ minify: true, pwa: false });
// the public feed's shared snapshot (Popular): the posts arrive over HTTP
const snapshot = JSON.stringify({ version: 1, generatedAt: Date.now(), notes, profiles: [profile], popUntil: now - 3600 });
const server = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === '/api/feed'
  ? new Response(snapshot, { headers: { 'content-type': 'application/json' } })
  : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', (r) => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(([notes, profile, replies]) => {
    class FakeSocket extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; this.subs = new Set();
        setTimeout(() => { this.readyState = 1; this.emit('open', new Event('open')); }, 0); }
      emit(type, ev) { this.dispatchEvent(ev); this['on' + type]?.(ev); }
      message(d) { this.emit('message', new MessageEvent('message', { data: JSON.stringify(d) })); }
      send(raw) {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m[0] === 'CLOSE') { this.subs.delete(m[1]); return; }
        if (m[0] !== 'REQ') return;
        const [, id, f] = m; this.subs.add(id);
        let evs = [];
        if (f.kinds?.includes(1) && !f.since) evs = notes.filter((e) => (!f.until || e.created_at <= f.until)
          && (!f.authors || f.authors.includes(e.pubkey)) && (!f.ids || f.ids.includes(e.id))).slice(0, f.limit || 100);
        if (f.kinds?.includes(0) && f.authors?.includes(profile.pubkey)) evs = [profile];
        if (f['#e']) evs = f.kinds?.includes(1) ? replies.filter((r) => r.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1]))) : [];
        if (f.ids) evs = notes.filter((e) => f.ids.includes(e.id));
        setTimeout(() => { if (!this.subs.has(id)) return; for (const e of evs) this.message(['EVENT', id, e]); this.message(['EOSE', id]); }, 30);
      }
      close() { this.readyState = 3; this.emit('close', new Event('close')); }
    }
    Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = FakeSocket;
  }, [notes, profile, replies]);
  await page.goto(server.url.origin + '/feed', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.notes-feed > [data-zap-post]').length >= 10, { timeout: 20000 }).catch(async (e) => { console.log(await page.evaluate(() => ({ t: document.body.innerText.slice(0, 600), path: location.pathname, cls: [...document.querySelectorAll("[class*=feed]")].map(e=>e.className).slice(0,10) })), errors); throw e; });
  const count = (id) => page.evaluate((id) => document.querySelector(`.notes-feed > [data-key="${id}"] .note-acts > .note-act:first-child .note-act-n`)?.textContent || '', id);
  await page.waitForFunction((id) => document.querySelector(`.notes-feed > [data-key="${id}"] .note-acts > .note-act:first-child .note-act-n`), { timeout: 10000 }, notes[0].id);
  assert.equal(await count(notes[0].id), '3', 'root post counts its whole conversation');
  assert.equal(await count(notes[1].id), '1', 'a quote is not a reply');
  assert.equal(await count(notes[2].id), '', 'no replies, no number');
  assert.deepEqual(errors, []);
  console.log('✓ reply buttons show 3 / 1 / nothing');
} finally { await browser.close(); server.stop(true); }
