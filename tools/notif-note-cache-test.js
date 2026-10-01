// Referenced notification notes are fetched before the page opens, persisted,
// and available on the first paint after a reload.
// Run: bun tools/notif-note-cache-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildHtml } from '../build.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ok = true;
const check = (name, pass, detail = '') => {
  console.log(` ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) ok = false;
};
const now = Math.floor(Date.now() / 1000);
const actorSk = generateSecretKey();
const actorPk = getPublicKey(actorSk);
const noteSk = generateSecretKey();
const noteText = 'This notification excerpt came from the local note cache.';
const target = finalizeEvent({ kind: 1, created_at: now - 120, tags: [], content: noteText }, noteSk);
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({
  port: 5307,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/punks') || path === '/verify-worker.js') return new Response(Bun.file('dist' + path));
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  },
});
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((targetEvent) => {
  window.__targetReqs = 0;
  const Real = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new Real(...args);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg[0] === 'REQ') {
          const filter = msg[2] || {};
          const hit = (filter.ids || []).includes(targetEvent.id);
          if (hit) window.__targetReqs++;
          setTimeout(() => {
            if (hit) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', msg[1], targetEvent]) }));
            ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', msg[1]]) }));
          }, 0);
          return;
        }
        if (msg[0] === 'EVENT') return;
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
}, target);

const clickText = (text) => page.evaluate((needle) => {
  const el = [...document.querySelectorAll('button')].find((node) => node.textContent.trim().toLowerCase().includes(needle));
  if (!el) return false;
  el.click(); return true;
}, text);
const waitText = async (text, timeout = 20_000) => {
  for (let elapsed = 0; elapsed < timeout; elapsed += 200) {
    if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(text.toLowerCase())) return true;
    await sleep(200);
  }
  return false;
};
const openNotifications = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find((node) => /notifications/i.test(node.getAttribute('aria-label') || ''));
  if (!el) return false;
  el.click(); return true;
});

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5307/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await clickText('create a new wallet');
  await page.waitForSelector('.words .w .t');
  const mnemonic = (await page.$$eval('.words .w .t', (nodes) => nodes.map((node) => node.textContent.trim()))).join(' ');
  await clickText('skip verification');
  await waitText('receive');
  const base = cacheKeyFor(mnemonic + '\n');
  const me = getPublicKey(privateKeyFromSeedWords(mnemonic));
  const item = { id: 'a'.repeat(64), what: 'react', actor: actorPk, target: target.id, hint: [], emoji: '❤️', ts: now - 30 };
  await page.evaluate(([key, owner, notification]) => {
    const state = JSON.parse(localStorage.getItem(key + ':messages') || '{}');
    state.notifs = [notification]; state.notifsPk = owner;
    localStorage.setItem(key + ':messages', JSON.stringify(state));
  }, [base, me, item]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive');

  let cached = false;
  for (let i = 0; i < 75; i++) {
    cached = await page.evaluate(([key, id]) => {
      const state = JSON.parse(localStorage.getItem(key + ':messages') || '{}');
      return state.notifNoteCache && state.notifNoteCache[id]?.content;
    }, [base, target.id]);
    if (cached) break;
    await sleep(200);
  }
  check('the referenced note is warmed and persisted', cached === noteText);
  check('the relay was queried while the page was still closed', (await page.evaluate(() => window.__targetReqs)) > 0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive');
  check('notifications opens from the bottom navigation', await openNotifications());
  await sleep(80);
  const firstPaint = await page.evaluate(() => document.body.innerText);
  check('the cached excerpt is present immediately', firstPaint.includes('This notification excerpt'));
  check('there is no Fetching note placeholder', !firstPaint.includes('Fetching note'));
  check('the persisted note avoids another target query', (await page.evaluate(() => window.__targetReqs)) === 0);
} finally {
  await browser.close();
  server.stop(true);
}

console.log(ok ? '\n✅ notification note cache works' : '\n❌ notification note cache failed');
process.exit(ok ? 0 : 1);
