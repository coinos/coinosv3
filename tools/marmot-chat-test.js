// Group chats (White Noise) in the real UI, against the Rust reference client.
//
//   bun tools/marmot-chat-test.js
//
// Same prerequisites as tools/marmot-interop-test.js (a local relay and a
// running `wn` daemon); skips cleanly without them. Every relay socket the
// page opens is pointed at the local relay, so nothing leaves the machine.
//
// Against a deployed site instead (real relays, throwaway identities):
//   SITE=https://v3.coinos.io RELAY=wss://relay.coinos.io bun tools/marmot-chat-test.js
// with the wn daemon started on public relays (e.g. wss://nos.lol).
//
// Covers: becoming invitable (KeyPackage published at boot), a wn group
// invitation → card → Join → messages both ways; "New message" to a White
// Noise user founding a direct group whose replies land in the DM thread;
// "New group" from the app.
import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
import { seedPubkey } from '../src/nostr.js';
import * as nip06 from 'nostr-tools/nip06';
import { finalizeEvent } from 'nostr-tools/pure';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// shots go somewhere every machine has
const shot = (name) => join(tmpdir(), name);

const RELAY = process.env.RELAY || 'ws://127.0.0.1:27777';
const SITE = process.env.SITE || '';
const PORT = 5247;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

function wn(args, account) {
  const r = spawnSync('wn', ['--json', ...(account ? ['--account', account] : []), ...args], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1) || '';
  try { const j = JSON.parse(line); return j.ok ? j.result : { error: j.error }; } catch { return { error: { message: (r.stderr || 'no output').trim() } }; }
}
function relayQuery(filter) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY), out = [];
    const done = () => { try { ws.close(); } catch {} resolve(out); };
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'q', filter]));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === 'EVENT') out.push(d[2]); if (d[0] === 'EOSE') done(); };
    ws.onerror = done;
    setTimeout(done, 3000);
  });
}
const until = async (fn, ms = SITE ? 45000 : 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(500); } };

if (wn(['whoami']).error) { console.log('SKIP: wn daemon not reachable'); process.exit(0); }
if (!(await relayQuery({ kinds: [0], limit: 1 }))) { console.log('SKIP: no relay'); process.exit(0); }
const alice = wn(['create-identity']).account_id, bob = wn(['create-identity']).account_id;

const server = SITE ? null : Bun.serve({
  port: PORT,
  fetch: ((html) => () => new Response(html, { headers: { 'content-type': 'text/html' } }))(await buildHtml({ minify: true, pwa: false })),
});

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 850 });
page.on('pageerror', (e) => { console.log('   page error:', e.message); ok = false; });
// DEBUG=1 turns on the app's debug switch and echoes the group-chat lines
if (process.env.DEBUG) {
  await page.evaluateOnNewDocument(() => localStorage.setItem('coinos-debug', '1'));
  page.on('console', async (m) => {
    if (!/^marmot/.test(m.text())) return;
    const args = await Promise.all(m.args().map((a) => a.evaluate((v) => (v instanceof Error ? v.message : typeof v === 'string' ? v : JSON.stringify(v))).catch(() => '?')));
    console.log('   [page]', args.join(' ').slice(0, 300));
  });
}
// every relay is the local relay
if (!SITE) await page.evaluateOnNewDocument((relay) => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) { return new Real(/^wss?:/.test(url) ? relay : url, protocols); };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  localStorage.setItem('coinos-group-relays', JSON.stringify([relay]));
  localStorage.setItem('btc-wallet-network', 'regtest');
}, RELAY);

const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const setInput = (sel, v) => page.evaluate((s, val) => { const e = document.querySelector(s); if (!e) return false; e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); return true; }, sel, v);
const bodyText = () => page.evaluate(() => document.body.innerText);
const waitText = (x, ms = 20000) => until(async () => (await bodyText()).toLowerCase().includes(x.toLowerCase()), ms);
const say = async (text) => {
  await page.waitForSelector('#msg-draft', { timeout: 15000 });
  await page.evaluate((v) => {
    const e = document.querySelector('#msg-draft');
    const ta = e.shadowRoot ? e.shadowRoot.querySelector('textarea') : (e.querySelector && e.querySelector('textarea')) || e;
    ta.focus();
    ta.value = v;
    ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }, text);
  await sleep(150);
  await page.keyboard.press('Enter');
};
const openChat = () => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /message/i.test(b.getAttribute('aria-label') || ''))?.click());

try {
  const mnemonic = generateMnemonic(wordlist);
  const me = seedPubkey(mnemonic);
  // wn follows an account's relay lists to real URLs; ours must name the
  // local relay before the wallet (which would publish its defaults) opens
  if (!SITE) {
    const sk = nip06.privateKeyFromSeedWords(mnemonic);
    const at = Math.floor(Date.now() / 1000);
    for (const ev of [
      finalizeEvent({ kind: 10002, created_at: at, tags: [['r', RELAY]], content: '' }, sk),
      finalizeEvent({ kind: 10050, created_at: at, tags: [['relay', RELAY]], content: '' }, sk),
    ]) await new Promise((res) => { const ws = new WebSocket(RELAY); ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev])); ws.onmessage = () => { ws.close(); res(); }; ws.onerror = res; });
  }
  await page.goto(SITE || `http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await click('button', 'Create a new wallet');
  await sleep(300);
  await click('button', 'Have an existing seed');
  await sleep(300);
  await page.waitForSelector('textarea');
  await page.type('textarea', mnemonic);
  await click('button', 'Open wallet');
  // a mainnet wallet is first offered a username: not now
  await until(async () => /receive|not now/i.test(await bodyText()), 20000);
  for (let i = 0; i < 3 && await click('button', 'Not now'); i++) await sleep(600);
  await waitText('receive', 15000);

  console.log('\n[invitable without doing anything]');
  const kp = await until(async () => (await relayQuery({ kinds: [30443], authors: [me] }))[0], 25000);
  check('a KeyPackage is published after boot', !!kp);
  const chk = wn(['keys', 'check', me]);
  check('wn can use it', !chk.error && JSON.stringify(chk).includes('true'), JSON.stringify(chk).slice(0, 200));

  console.log('\n[a White Noise group invites us]');
  const made = wn(['groups', 'create', 'Trail crew', me], alice);
  check('wn groups create', !made.error, JSON.stringify(made.error || ''));
  const gid = made.group_id || made.group?.group_id;
  await openChat();
  check('invitation card shows', !!await waitText('invited you to Trail crew', 25000));
  await click('button', 'Join');
  check('the group opens', !!await waitText('2 members'));
  wn(['messages', 'send', gid, 'hello from white noise'], alice);
  // on public relays a dropped socket is only noticed by the watchdog's next pass
  const arrived = !!await waitText('hello from white noise', SITE ? 120000 : 20000);
  check('their message arrives', arrived);
  if (!arrived && process.env.DEBUG) {
    const chat = (wn(['chats', 'list'], alice).chats || []).find((c) => c.group_id === gid) || {};
    const r = chat.nostr_routing || {};
    console.log('   wn routing', JSON.stringify(r.relays), 'last', JSON.stringify(chat.last_message || {}).slice(0, 200));
    console.log('   wn messages', JSON.stringify(wn(['messages', 'list', gid, '--limit', '5'], alice)).slice(0, 400));
    for (const url of r.relays || []) {
      const evs = await new Promise((res) => { const ws = new WebSocket(url), out = []; ws.onopen = () => ws.send(JSON.stringify(['REQ', 'q', { kinds: [445], '#h': [r.nostr_group_id_hex] }])); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === 'EVENT') out.push(d[2]); else res(out); }; setTimeout(() => res(out), 4000); });
      console.log('   ', url, 'holds', evs.length, 'group events', evs.map((e) => e.created_at).join(','));
    }
  }
  await say('hello from coinos');
  check('ours reaches wn', !!await until(() => JSON.stringify(wn(['messages', 'list', gid, '--limit', '20'], alice)).includes('hello from coinos')));
  await page.screenshot({ path: shot('marmot-group.png') });

  console.log('\n[a first message to a White Noise user founds a direct chat]');
  await page.evaluate(() => document.querySelector('.chat-head button')?.click()); // back
  await sleep(400);
  await click('button', 'New message');
  await sleep(300);
  await setInput('input[placeholder*="npub" i]', bob);
  await click('button', 'Open');
  await page.waitForSelector('#msg-draft');
  await sleep(2500); // their KeyPackage is looked up when the thread opens
  await say('hi bob, direct');
  const bobChat = await until(() => { const l = wn(['chats', 'list'], bob); const s = JSON.stringify(l); return s.includes('group_id') && !s.includes('"chats":[]') ? l : null; }, 25000);
  check('bob has a chat', !!bobChat, JSON.stringify(wn(['groups', 'invites'], bob)).slice(0, 200));
  const dmGid = JSON.stringify(bobChat || '').match(/"group_id":"([0-9a-f]+)"/)?.[1];
  if (dmGid) {
    wn(['groups', 'accept', dmGid], bob);
    check('bob reads our first message', !!await until(() => JSON.stringify(wn(['messages', 'list', dmGid, '--limit', '20'], bob)).includes('hi bob, direct')));
    wn(['messages', 'send', dmGid, 'hey, bob here'], bob);
    check('his reply lands in the same thread', !!await waitText('hey, bob here'));
    await say('second message');
    check('a reply goes back the same way', !!await until(() => JSON.stringify(wn(['messages', 'list', dmGid, '--limit', '20'], bob)).includes('second message')));
  }
  await page.screenshot({ path: shot('marmot-dm.png') });

  console.log('\n[New group from the app]');
  await page.evaluate(() => document.querySelector('.chat-head button')?.click());
  await sleep(400);
  await click('button', 'New group');
  await sleep(300);
  await setInput('input[placeholder="Group name"]', 'Made in coinos');
  for (const who of [alice, bob]) {
    await setInput('input[placeholder^="Add people"]', who);
    await page.focus('input[placeholder^="Add people"]');
    await page.keyboard.press('Enter');
    await sleep(300);
  }
  await until(async () => !(await bodyText()).includes('checking'), 15000);
  await click('button', 'Create group');
  check('the new group opens', !!await waitText('3 members', 25000));
  const theirs = await until(() => { const s = JSON.stringify(wn(['chats', 'list'], alice)) + JSON.stringify(wn(['groups', 'invites'], alice)); return s.includes('Made in coinos'); }, 25000);
  check('wn sees the group', !!theirs);
  await say('welcome everyone');
  const rows = [...(wn(['chats', 'list'], alice).chats || []), ...(wn(['groups', 'invites'], alice).invites || [])];
  const ng = (rows.find((c) => JSON.stringify(c).includes('Made in coinos')) || {}).group_id;
  if (ng) {
    wn(['groups', 'accept', ng], alice);
    check('wn reads the group message', !!await until(() => JSON.stringify(wn(['messages', 'list', ng, '--limit', '20'], alice)).includes('welcome everyone')));
    wn(['messages', 'send', ng, 'thanks!'], alice);
    check('and answers', !!await waitText('thanks!'));
  } else check('found the group id on the wn side', false, JSON.stringify(wn(['chats', 'list'], alice)).slice(0, 300));
  await page.screenshot({ path: shot('marmot-newgroup.png') });

  console.log('\n[it is all still there after a reload]');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 15000);
  await openChat();
  check('groups listed after reload', !!await waitText('Made in coinos') && !!await waitText('Trail crew'));
  await page.screenshot({ path: shot('marmot-home.png') });

  console.log('\n[someone without a KeyPackage still gets a NIP-17 DM]');
  const stranger = seedPubkey(generateMnemonic(wordlist));
  await click('button', 'New message');
  await sleep(300);
  await setInput('input[placeholder*="npub" i]', stranger);
  await click('button', 'Open');
  await say('plain old dm');
  check('the message shows', !!await waitText('plain old dm'));
  check('a gift wrap went to their inbox', !!await until(async () => (await relayQuery({ kinds: [1059], '#p': [stranger] })).length > 0, 15000));
  check('no group was founded for it', (await relayQuery({ kinds: [1059], '#p': [stranger] })).length <= 1);
} catch (e) { console.log(e); ok = false; }
await browser.close();
if (server) server.stop();
console.log(ok ? '\nall passed' : '\nFAILED');
process.exit(ok ? 0 : 1);
