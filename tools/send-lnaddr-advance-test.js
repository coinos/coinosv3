// A lightning address on the Send form moves on to the amount by itself
// when it's pasted (any paste, not just the Paste button), or typed and left
// alone a moment — but only once it's real: a half-typed domain just waits,
// with no error. Uses the live registrar and DNS (adam@coinos.io).
// Run: bun tools/send-lnaddr-advance-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p.startsWith('/punks') || p === '/verify-worker.js' || p.startsWith('/locales') || /\.js$/.test(p)) { const f = Bun.file('dist' + p); return f.size ? new Response(f) : new Response('', { status: 404 }); }
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(server.url.origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const state = () => page.evaluate(() => ({
  amount: !!document.querySelector('input[type=number]'),
  via: document.querySelector('.send-via')?.innerText || '',
  field: document.querySelector('textarea.send-dest')?.value ?? null,
  err: document.querySelector('.notice.err')?.innerText || '',
  resolving: /looking up|resolving/i.test(document.body.innerText),
}));
const freshSend = async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Receive')?.click()); await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send')?.click());
  await page.waitForSelector('textarea.send-dest', { timeout: 10000 });
  await page.$eval('textarea.send-dest', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);
  await page.focus('textarea.send-dest');
};
// resolved: the amount is up and the field still says the name (it went to the person's Ark address underneath)
const moved = (s) => s.amount && s.field === 'adam@coinos.io' && /instantly/i.test(s.via);
const waitAdvance = async (ms) => { for (let i = 0; i < ms / 250; i++) { const s = await state(); if (moved(s)) return s; await sleep(250); } return state(); };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.origin, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(500); await click('to import'); await sleep(400);
  await page.waitForSelector('textarea'); await page.type('textarea', generateMnemonic(wordlist)); await click('open wallet');
  // mainnet onboarding: skip the username step (and anything after it)
  for (let i = 0; i < 80 && !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Send'))); i++) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^(not now|skip|continue|later)$/i.test(b.textContent.trim()))?.click());
    await sleep(400);
  }
  await sleep(3000); // features (names, zaps, ark) load

  console.log('[pasted with the keyboard]');
  await freshSend();
  await page.evaluate(() => navigator.clipboard.writeText('adam@coinos.io'));
  await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
  let s = await waitAdvance(10000);
  check('a pasted lightning address goes straight on to the amount', moved(s), JSON.stringify(s));

  console.log('[typed, then left alone]');
  await freshSend();
  await page.keyboard.type('adam@coinos.io', { delay: 60 });
  s = await state();
  check('nothing happens mid-typing', !s.amount && s.field === 'adam@coinos.io', JSON.stringify(s));
  s = await waitAdvance(10000);
  check('a moment after typing stops, it moves on by itself', moved(s), JSON.stringify(s));

  console.log('[a half-typed domain]');
  await freshSend();
  await page.keyboard.type('adam@coinos.i', { delay: 60 });
  await sleep(5000);
  s = await state();
  check('a domain that answers nothing just waits', !s.amount && s.field === 'adam@coinos.i', JSON.stringify(s));
  check('...with no error on screen', !s.err, s.err);
  await page.keyboard.type('o', { delay: 60 });
  s = await waitAdvance(10000);
  check('finishing it then moves on', moved(s), JSON.stringify(s));
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  check('run completed', false, e.stack);
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ lightning addresses move on by themselves, but only once real' : '\n❌ failures above');
process.exit(ok ? 0 : 1);
