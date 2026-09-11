// The padlock is answerable from wherever it's tapped. Feature screens (your
// profile, a chat thread) are drawn ahead of the wallet screen, and the
// "Protect this device?" card is drawn BY the wallet screen — so the tap used
// to do nothing visible until you navigated home and the card finally
// appeared there. The ask outranks feature screens now, and declining still
// leaves you exactly where you tapped.
//
// Run: bun tools/padlock-ask-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5231, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const bodyText = () => page.evaluate(() => document.body.innerText);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await bodyText()).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5231/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('button', 'get started');
  await sleep(500);
  await click('button', 'Import existing');
  await sleep(400);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  await waitText('receive', 20000);

  // open my own profile (the header avatar)
  await page.evaluate(() => document.querySelector('.header-avatar')?.click());
  await sleep(900);
  const onProfile = await page.evaluate(() => !!document.querySelector('.profile-avatar, .chat-avatar.profile-avatar'));
  check('profile page is open', onProfile, (await bodyText()).slice(0, 60).replace(/\n/g, ' | '));

  // tap the padlock — the ask must appear without navigating anywhere
  const tapped = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) => /lock/i.test(e.getAttribute('aria-label') || ''));
    if (!b) return false; b.click(); return true;
  });
  check('padlock is reachable from the profile page', tapped);
  await sleep(500);
  const text = await bodyText();
  check('the ask appears on the tap', /protect this device/i.test(text), text.split('\n').slice(0, 3).join(' | '));

  // declining lands back on the profile, not somewhere else
  await click('button', 'not now');
  await sleep(600);
  const back = await page.evaluate(() => !!document.querySelector('.profile-avatar'));
  check('declining lands back on the profile page', back, (await bodyText()).slice(0, 60).replace(/\n/g, ' | '));
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ padlock ask is immediate' : '\n❌ failed');
process.exit(ok ? 0 : 1);
