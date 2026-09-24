// A signed-in wallet must never flash the signed-out welcome screen. Anything
// that renders before boot has restored the session (a deferred feature chunk
// landing, an emitter tick) is rendering without knowing whether anyone is
// signed in, and the start page over a wallet that's about to open is the one
// wrong guess that's unmistakable.
//
// The race is widened here (the locale fetch is delayed, so the deferred
// chunks land in the gap) and every animation frame of the boot is checked
// for the welcome screen.
//
// Run: bun tools/boot-signin-flash-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5234, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
let ok = true;
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5234/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(500);
  await click('to import'); await sleep(400);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('open wallet');
  await waitText('receive', 20000);

  // Reload with the locale fetch held back, so whatever else renders during
  // boot gets its chance, and watch every frame.
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch;
    window.fetch = (...a) => {
      const url = String(a[0] && a[0].url ? a[0].url : a[0]);
      if (/locale|\.json$/i.test(url)) return sleepThen(600).then(() => orig(...a));
      return orig(...a);
    };
    const sleepThen = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__frames = [];
    window.__sawSignin = null;
    const tick = () => {
      const txt = (document.body && document.body.innerText) || '';
      if (!window.__sawSignin && /create a new wallet|sign in with/i.test(txt)) window.__sawSignin = Math.round(performance.now());
      if (!window.__walletAt && document.querySelector('.balance')) window.__walletAt = Math.round(performance.now());
      if (!window.__walletAt) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 1; i <= 4; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const r = await page.evaluate(() => ({ signin: window.__sawSignin, wallet: window.__walletAt }));
    const clean = r.signin == null && r.wallet != null;
    console.log(` ${clean ? '✓' : '✗'} reload ${i}: wallet at ${r.wallet}ms${r.signin != null ? `, sign-in page flashed at ${r.signin}ms` : ', no sign-in flash'}`);
    if (!clean) ok = false;
  }
  const rootId = 'c'.repeat(64), replyId = 'd'.repeat(64), author = 'a'.repeat(64);
  await page.evaluate(({ rootId, replyId, author }) => {
    const root = { id: rootId, pubkey: author, kind: 1, content: 'Cached thread root', tags: [], created_at: 1 };
    const reply = { ...root, id: replyId, content: 'Cached thread reply', tags: [['e', rootId, '', 'root']], created_at: 2 };
    localStorage.setItem('btc-wallet-note-threads', JSON.stringify([{ rootId, root, replies: [reply], profiles: {}, counts: {} }]));
    const nav = { ...history.state.nav, screen: 'wallet', noteThread: { rootId, focusId: replyId, seed: reply } };
    history.replaceState({ nav, i: 0 }, '', location.href);
  }, { rootId, replyId, author });
  await page.evaluateOnNewDocument(() => {
    window.__threadBoot = { homeFrames: 0, animatedFrames: 0, threadAt: null };
    const tick = () => {
      const state = window.__threadBoot;
      if (document.querySelector('.balance')) state.homeFrames++;
      const thread = document.querySelector('.thread-page');
      if (thread?.classList.contains('anim-page')) state.animatedFrames++;
      if (thread) state.threadAt ??= Math.round(performance.now());
      if (state.threadAt == null || performance.now() - state.threadAt < 500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const thread = await page.evaluate(() => window.__threadBoot);
  const steady = thread.threadAt != null && !thread.homeFrames && !thread.animatedFrames;
  console.log(` ${steady ? '✓' : '✗'} thread reload: ${thread.homeFrames} home frames, ${thread.animatedFrames} page animation frames`);
  if (!steady) ok = false;
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ no sign-in flash' : '\n❌ the sign-in page flashed');
process.exit(ok ? 0 : 1);
