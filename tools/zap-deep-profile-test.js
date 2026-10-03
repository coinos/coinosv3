// A zap must find the author's lightning address even when our relays have
// pruned their kind 0 — the profile page already finds it through index
// relays and the author's own relays; the zap path has to look there too.
//
// Live: real relays, a throwaway mainnet wallet (no funds, so the zap stops
// at "not enough in Spending" — past the address lookup, which is the point).
//
// Run: bun tools/zap-deep-profile-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';

// 1776: a kind 0 with lud16 that none of our home relays still carry (2026-10-02)
const NPUB = 'npub1e7dj5ymf5nxezvnrnvf6uwfqp4crqschn2q5apjga8jngzfhamqsemfw7d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5253, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900 });
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const text = () => page.evaluate(() => document.body.innerText);
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(400); } };

try {
  await page.goto('http://localhost:5253/', { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await click('button', 'Create a new wallet'); await sleep(300);
  await click('button', 'Have an existing seed'); await sleep(300);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  await until(async () => /receive|not now/i.test(await text()), 20000);
  for (let i = 0; i < 3 && await click('button', 'Not now'); i++) await sleep(600);
  await page.goto('http://localhost:5253/' + NPUB, { waitUntil: 'domcontentloaded' });
  check('their profile shows the lightning address', !!await until(async () => /fervidwage316/.test(await text()), 30000));
  const zapBtn = await until(() => page.$('.note-actions .zap, button.zap, [aria-label*="zap" i]'), 20000);
  check('a post with a zap button', !!zapBtn);
  if (zapBtn) {
    await zapBtn.click();
    // whatever the zap ends in, it says so in a toast or on the zap screen
    const said = await until(() => page.evaluate(() => {
      const t = [...document.querySelectorAll('.toast, .notice')].map((n) => n.textContent.trim()).filter(Boolean).join(' | ');
      return t || null;
    }), 30000);
    check('the zap gets past the address lookup', !!said && !/no Lightning address or Ark/.test(said), said || 'nothing said');
  }
} catch (e) { console.log(e); ok = false; }
await browser.close();
server.stop();
console.log(ok ? '\nall passed' : '\nFAILED');
process.exit(ok ? 0 : 1);
