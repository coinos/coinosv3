// dist/standalone.html opened straight from a disk: its own font, the
// wizard's punks and a language pack all arrive with no files beside it.
// Run: bun run build && bun tools/standalone-file-test.js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [], failed = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => { if (r.url().startsWith('file:')) failed.push(r.url()); });
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('file://' + resolve(process.argv[2] || 'dist/standalone.html'));
  await sleep(1500);
  const click = (x) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); e?.click(); return !!e; }, x);
  assert(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Public Sans"') && [...document.fonts].some((f) => f.status === 'loaded'); }), 'the embedded font loads');
  // a language pack from the site, read cross-origin
  await page.evaluate(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'de')); s.value = 'de'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.documentElement.lang === 'de' || /Wallet erstellen|Neue Wallet/i.test(document.body.innerText), { timeout: 8000 })
    .catch(() => {});
  const de = await page.evaluate(() => document.body.innerText.slice(0, 120));
  assert(!/Create a new wallet/.test(de), 'German strings arrived: ' + de);
  await page.evaluate(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'en')); s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(500);
  await click('create a new wallet'); await sleep(1500);
  await click('skip verification'); await sleep(1500);
  // the avatar step comes after a name claim; resume the wizard there
  await page.evaluate(() => localStorage.setItem('btc-wallet-onb-step', 'avatar'));
  await page.reload(); await sleep(2500);
  await page.waitForSelector('.onb-punk', { timeout: 8000 }).catch(async (e) => { console.log(await page.evaluate(() => document.body.innerText.slice(0, 300))); throw e; });
  await page.waitForFunction(() => [...document.querySelectorAll('img.onb-punk')].every((i) => i.complete), { timeout: 10000 });
  const punks = await page.evaluate(() => [...document.querySelectorAll('img.onb-punk')].map((i) => ({ w: i.naturalWidth, src: i.src.slice(0, 40) })));
  const big = await page.evaluate(async () => { const i = document.querySelector('img.onb-punk'); i.click(); await new Promise((r) => setTimeout(r, 1500));
    const a = document.querySelector('img.onb-avatar'); return { ok: a.complete && a.naturalWidth > 0, src: a.src.slice(0, 40) }; });
  assert(big.ok, 'the picked punk shows big: ' + JSON.stringify(big));
  assert(punks.length >= 10 && punks.every((p) => p.w > 0), 'every punk tile painted: ' + JSON.stringify(punks.slice(0, 3)));
  assert.deepEqual(failed, [], 'nothing looked for beside the file');
  assert.deepEqual(errors, []);
  console.log(`✓ standalone from disk: embedded font, German pack, ${punks.length} punks from ${punks[0].src}`);
} finally { await browser.close(); }
