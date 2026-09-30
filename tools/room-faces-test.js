// Opening a community must not paint everyone as a punk and then swap in
// their real pictures: faces are warmed on hover/press (and while the list
// sits there) and the tap waits a moment for them. A fresh wallet has no
// profiles cached — the worst case — against the real coinos community.
//
// Run: bun tools/room-faces-test.js [--no-hover]
import puppeteer from 'puppeteer-core';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5277, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5277/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  await click('skip verification');
  await waitText('receive', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.app-bottom-nav .app-nav-button')][1].click());
  await waitText('members', 20000);
  // let the community's history arrive (the list shows before it has)
  await sleep(process.argv.includes('--no-hover') ? 1500 : 6000);
  const face = () => [...document.querySelectorAll('.chat-log .chat-row > .chat-avatar:not(.spacer), .chat-log .chat-row > .hat-wrap > .chat-avatar')]
    .map((a) => a.classList.contains('ava-img') ? 'pic' : a.querySelector('img.punk') ? 'punk' : a.classList.contains('loading') ? 'wait' : 'other');
  // name -> face state, per author (rows stream in, so positions shift)
  const keyed = () => { const o = {}; for (const r of document.querySelectorAll('.chat-log .chat-row')) {
    const a = r.querySelector(':scope > .chat-avatar:not(.spacer), :scope > .hat-wrap > .chat-avatar'); const n = r.querySelector('.chat-meta')?.firstElementChild?.textContent;
    if (a && n) o[n] = a.classList.contains('ava-img') ? 'pic' : a.querySelector('img.punk') ? 'punk' : a.classList.contains('loading') ? 'wait' : 'other'; } return o; };
  await page.evaluate((fs) => {
    const face = new Function('return ' + fs)();
    const mo = new MutationObserver(() => { if (!window.__first && document.querySelector('.chat-log .chat-row')) { window.__first = face(); window.__firstAt = performance.now(); } });
    mo.observe(document.body, { childList: true, subtree: true });
  }, face.toString());
  const row = await page.evaluateHandle(() => [...document.querySelectorAll('.chat-thread-row')].find((r) => /members/.test(r.innerText)));
  const t0 = await page.evaluate(() => performance.now());
  if (!process.argv.includes('--no-hover')) await row.hover();
  await row.click();
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__first)); i++) await sleep(100);
  await sleep(1200);
  const at1s = await page.evaluate(new Function('return (' + face.toString() + ')()'));
  check('no face is still a blank circle a second after the room shows', !at1s.includes('wait'), JSON.stringify(tally(at1s)));
  await sleep(4800);
  const [first, at] = await page.evaluate(() => [window.__first, window.__firstAt]);
  const last = await page.evaluate(new Function('return (' + face.toString() + ')()'));
  const flips = (first || []).filter((f, i) => f === 'punk' && last[i] === 'pic').length;
  console.log('   first paint after', Math.round(at - t0), 'ms:', JSON.stringify(tally(first)), ' settled:', JSON.stringify(tally(last)));
  check('the room opens with its messages', (first || []).length > 0);
  check('no face paints as a punk and then turns into a picture', flips === 0, flips + ' flipped');
  check('the tap waits no more than a moment', at - t0 < 2500, Math.round(at - t0) + 'ms');

  if (process.argv.includes('--refresh')) {
    // a reload inside the room: every face as it will stay, from the first
    // frame — a known-faceless member is their punk at once, not a blank
    // circle that turns into one. (Wait out the second ask that confirms
    // who has no profile.)
    await sleep(8000);
    await page.evaluateOnNewDocument((fs, ks) => {
      const face = new Function('return ' + fs)();
      const keyed = new Function('return ' + ks)();
      const mo = new MutationObserver(() => { if (!window.__first && document.querySelector('.chat-log .chat-row')) { window.__first = face(); window.__firstBy = keyed(); } });
      addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
    }, face.toString(), keyed.toString());
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__first)); i++) await sleep(100);
    await sleep(6000);
    const f2 = await page.evaluate(() => window.__first);
    const l2 = await page.evaluate(new Function('return (' + face.toString() + ')()'));
    const byName = await page.evaluate(new Function('return (' + keyed.toString() + ')()'));
    const firstBy = await page.evaluate(() => window.__firstBy);
    const changedWho = Object.keys(firstBy || {}).filter((k) => byName[k] && firstBy[k] !== byName[k] && !(firstBy[k] === 'punk' && byName[k] === 'other'));
    if (changedWho.length) console.log('   changed:', changedWho.map((k) => k + ' ' + firstBy[k] + '→' + byName[k]).join(', '));
    const changed = changedWho.length;
    console.log('   after reload, first paint:', JSON.stringify(tally(f2)), ' settled:', JSON.stringify(tally(l2)));
    check('after a reload in the room, no face changes once painted', !!f2 && changed === 0, changed + ' changed');
  }
} finally { await browser.close(); server.stop(true); }
function tally(a) { const o = {}; for (const x of a || []) o[x] = (o[x] || 0) + 1; return o; }
console.log(ok ? '\n✅ a room opens with its faces' : '\n❌ failed');
process.exit(ok ? 0 : 1);
