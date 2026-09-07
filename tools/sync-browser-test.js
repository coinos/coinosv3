// Actual Chrome storage + WebSocket relay: interrupted publish, restart,
// retry, and an already-connected second device adopting the missing change.
// Run: bun tools/sync-browser-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { verifyEvent } from 'nostr-tools/pure';

const build = await Bun.build({ entrypoints: ['./tools/sync-browser-harness.js'], target: 'browser', minify: true });
assert.ok(build.success);
const script = await build.outputs[0].text();
let accepting = true, rejected = 0;
const events = new Map();
const server = Bun.serve({
  port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === '/relay' && server.upgrade(req)) return;
    if (path === '/harness.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (path !== '/') return new Response('', { status: 404 });
    return new Response('<body>0<script type="module" src="/harness.js"></script>', { headers: { 'content-type': 'text/html' } });
  },
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m[0] === 'EVENT') {
        const e = m[1];
        if (!accepting) { rejected++; ws.send(JSON.stringify(['OK', e.id, false, 'rate-limited: test outage'])); return; }
        assert.ok(verifyEvent(e));
        const key = e.pubkey + ':' + e.tags.find(t => t[0] === 'd')[1];
        const old = events.get(key);
        if (!old || e.created_at > old.created_at || (e.created_at === old.created_at && e.id < old.id)) events.set(key, e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
      }
      if (m[0] === 'REQ') {
        const filter = m[2];
        for (const e of events.values()) if (filter.authors.includes(e.pubkey) && filter.kinds.includes(e.kind)) ws.send(JSON.stringify(['EVENT', m[1], e]));
        ws.send(JSON.stringify(['EOSE', m[1]]));
      }
    },
  },
});
let browser;
try {
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const first = await browser.createBrowserContext(), second = await browser.createBrowserContext();
  const open = async context => { const p = await context.newPage(); await p.goto(`http://127.0.0.1:${server.port}/`); await p.waitForFunction(() => !!window.syncTest); return p; };
  let sender = await open(first);
  const receiver = await open(second);
  const initial = { vtxos: [{ id: 'deposit', amountSat: 5000, state: 'spendable' }], actions: [], movements: [], nextKeyIndex: 1 };
  await sender.evaluate(s => syncTest.save(s), initial);
  await sender.waitForFunction(() => syncTest.records().every(r => r.acknowledged));
  await receiver.evaluate(() => syncTest.restore());
  assert.equal(await receiver.$eval('body', b => b.textContent), '5000');

  accepting = false;
  const paid = { vtxos: [{ id: 'deposit', amountSat: 5000, state: 'spent' }, { id: 'change', amountSat: 4499, state: 'spendable' }], actions: [], movements: [{ id: 'test-payment', type: 'ln-send', status: 'complete', amountSat: 501, inputIds: ['deposit'] }], nextKeyIndex: 19 };
  await sender.evaluate(s => syncTest.save(s), paid);
  for (let i = 0; i < 50 && !rejected; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(rejected, 'test relay must refuse the updated state');
  assert.equal((await sender.evaluate(() => syncTest.records()))[0].acknowledged, false);
  await sender.close();
  accepting = true;
  sender = await open(first);
  await sender.waitForFunction(() => syncTest.records().length && syncTest.records().every(r => r.acknowledged));
  const state = await receiver.evaluate(() => syncTest.restore());
  assert.equal(await receiver.$eval('body', b => b.textContent), '4499');
  assert.equal(state.nextKeyIndex, 19);
  assert.equal(state.movements[0].amountSat, 501);
  console.log('✓ Chrome restart retries refused snapshot from persistent storage');
  console.log('✓ independent connected browser recovers 4499 sats and history without reload');
} finally {
  await browser?.close();
  server.stop(true);
}
