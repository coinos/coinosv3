// Settings → Nostr → Relays: the card loads the identity's published NIP-65
// list (read/write markers) and NIP-17 inbox list, edits them, and publishes
// both only after a fresh lookup, newer than the copies it replaces.
// No relay is written for real — the WebSocket shim swallows EVENT.
// Run: bun tools/relays-settings-test.js
import puppeteer from 'puppeteer-core';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const now = Math.floor(Date.now() / 1000);

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5298, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__published = [];
  const Real = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new Real(...a);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      try {
        const m = JSON.parse(data);
        if (m[0] === 'REQ' && m[2]) {
          const f = m[2];
          const kinds = f.kinds || [];
          const lists = (window.__lists || []).filter((e) => kinds.includes(e.kind) && (f.authors || []).includes(e.pubkey));
          if (kinds.includes(10002) || kinds.includes(10050)) {
            setTimeout(() => {
              for (const ev of lists) ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', m[1], ev]) }));
              ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', m[1]]) }));
            }, 0);
            return;
          }
        }
        if (m[0] === 'EVENT' && m[1]) {
          window.__published.push(m[1]);
          setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['OK', m[1].id, true, '']) })), 0);
          return;
        }
      } catch {}
      return send(data);
    };
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const text = () => page.evaluate(() => document.body.innerText);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await text()).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 10000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; };
const rows = () => page.evaluate(() => [...document.querySelectorAll('.relays-card .relay-row')].map((r) => ({
  url: r.querySelector('.mono').textContent, on: [...r.querySelectorAll('.feed-chip.on')].map((c) => c.textContent) })));
const dms = () => page.evaluate(() => [...document.querySelectorAll('.relays-card .relay-dm-row .mono')].map((r) => r.textContent));
const openNostrSettings = async () => {
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => e.getAttribute('aria-label') === 'Settings'); b.click(); }); await sleep(600);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.settings-tile')].find((e) => [...e.querySelectorAll('span')].some((x) => x.textContent.trim() === 'Nostr')); if (b) b.click(); }); await sleep(800);
};

try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5298/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const ME_SK = privateKeyFromSeedWords(mn);
  const ME = getPublicKey(ME_SK);
  const R = finalizeEvent({ kind: 10002, created_at: now - 100, content: '',
    tags: [['r', 'wss://relay.coinos.io'], ['r', 'wss://nos.lol', 'read'], ['r', 'wss://relay.example.com', 'write']] }, ME_SK);
  const DM = finalizeEvent({ kind: 10050, created_at: now - 100, content: '', tags: [['relay', 'wss://relay.coinos.io'], ['relay', 'wss://inbox.example.com']] }, ME_SK);
  await page.evaluate((l) => { window.__lists = l; }, [R, DM]);

  console.log('\n[the card shows what this identity published]');
  await openNostrSettings();
  check('a Relays card is on Settings → Nostr', await waitFor(() => !!document.querySelector('.relays-card')));
  check('...listing the NIP-65 relays with their markers', await waitFor(() => document.querySelectorAll('.relays-card .relay-row').length === 3), JSON.stringify(await rows()));
  const r0 = await rows();
  check('both / read-only / write-only read back right',
    JSON.stringify(r0) === JSON.stringify([
      { url: 'relay.coinos.io', on: ['Read', 'Write'] }, { url: 'nos.lol', on: ['Read'] }, { url: 'relay.example.com', on: ['Write'] }]),
    JSON.stringify(r0));
  check('...and the DM inbox list', JSON.stringify(await dms()) === JSON.stringify(['relay.coinos.io', 'inbox.example.com']), JSON.stringify(await dms()));

  console.log('\n[editing, then saving]');
  await click('save'); await sleep(400);
  check('saving with nothing changed publishes nothing', !(await page.evaluate(() => window.__published)).some((e) => e.kind === 10002 || e.kind === 10050));
  // nos.lol becomes read+write; relay.example.com goes; a bare host is added
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.relays-card .relay-row')].find((r) => r.textContent.includes('nos.lol'));
    [...row.querySelectorAll('.feed-chip')].find((c) => c.textContent === 'Write').click();
  }); await sleep(100);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.relays-card .relay-row')].find((r) => r.textContent.includes('relay.example.com'));
    row.querySelector('.linklike').click();
  }); await sleep(100);
  await page.click('.relay-add'); await page.type('.relay-add', 'Relay.Damus.io'); await page.keyboard.press('Enter'); await sleep(200);
  check('the field empties once a relay is added', await page.$eval('.relay-add', (e) => e.value === ''));
  if (process.env.SHOT) await (await page.$('.relays-card')).screenshot({ path: process.env.SHOT });
  await page.click('.relay-add', { clickCount: 3 }); await page.type('.relay-add', 'not a relay!'); await page.keyboard.press('Enter'); await sleep(200);
  check('a junk address is refused', !(await rows()).some((r) => /not a relay/.test(r.url)));
  check('the list reads as edited', JSON.stringify(await rows()) === JSON.stringify([
    { url: 'relay.coinos.io', on: ['Read', 'Write'] }, { url: 'nos.lol', on: ['Read', 'Write'] }, { url: 'relay.damus.io', on: ['Read', 'Write'] }]), JSON.stringify(await rows()));
  await page.evaluate(() => { window.__published = []; document.querySelector('.relays-save').click(); });
  check('a kind 10002 goes out', await waitFor(() => window.__published.some((e) => e.kind === 10002), 15000));
  const pub = await page.evaluate(() => window.__published);
  const nip65 = pub.find((e) => e.kind === 10002);
  check('...with exactly the edited relays, signed by me, newer than the old one',
    nip65.pubkey === ME && nip65.created_at > R.created_at
      && JSON.stringify(nip65.tags) === JSON.stringify([['r', 'wss://relay.coinos.io'], ['r', 'wss://nos.lol'], ['r', 'wss://relay.damus.io']]),
    JSON.stringify(nip65.tags));
  check('...and the untouched inbox list is not republished', !pub.some((e) => e.kind === 10050));
  check('wallet sync follows the new write relays', await page.evaluate(() => JSON.parse(localStorage.getItem('btc-wallet-sync')).relays.includes('wss://relay.damus.io')));

  console.log('\n[a newer list from another app wins]');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.relays-card .relay-dm-row')].find((r) => r.textContent.includes('inbox.example.com'));
    row.querySelector('.linklike').click();
  }); await sleep(100);
  const DM2 = finalizeEvent({ kind: 10050, created_at: now + 5, content: '', tags: [['relay', 'wss://elsewhere.example.com']] }, ME_SK);
  await page.evaluate((l) => { window.__lists = l; window.__published = []; document.querySelector('.relays-save').click(); }, [nip65, DM2]);
  check('the save is abandoned and the card reloads the newer copy', await waitFor(() => [...document.querySelectorAll('.relays-card .relay-dm-row')].some((r) => r.textContent.includes('elsewhere.example.com')), 15000), JSON.stringify(await dms()));
  check('...nothing published over it', !(await page.evaluate(() => window.__published)).some((e) => e.kind === 10050));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ relays: lists load, edit and publish safely' : '\n❌ failed');
process.exit(ok ? 0 : 1);
