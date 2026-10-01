// Settings → Notifications lists zaps and reactions as their own categories,
// each with its own switch. Run: bun tools/notif-categories-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', (r) => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
  const click = (x) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, x);
  await page.goto(server.url.origin + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload(); await sleep(500);
  await click('create a new wallet'); await sleep(600);
  await click('skip verification'); await sleep(300);
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('receive'), { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((e) => e.getAttribute('aria-label') === 'Settings').click()); await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll('.settings-tile')].find((e) => /notification/i.test(e.textContent)).click()); await sleep(600);
  const rows = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.card .row.between')]
    .map((r) => [r.querySelector('span')?.textContent, r.querySelector('button')?.textContent])));
  const before = await rows();
  for (const k of ['Payments received', 'Zaps on your posts', 'Direct messages', 'Replies and mentions on nostr', 'Reactions to your posts'])
    assert.equal(before[k], 'On', k + ' is listed and on by default');
  await page.evaluate(() => [...document.querySelectorAll('.card .row.between')].find((r) => /Reactions/.test(r.textContent)).querySelector('button').click());
  await sleep(500);
  const after = await rows();
  assert.equal(after['Reactions to your posts'], 'Off', 'reactions switch off on their own');
  assert.equal(after['Zaps on your posts'], 'On');
  assert.equal(after['Replies and mentions on nostr'], 'On');
  assert.deepEqual(errors, []);
  console.log('✓ zaps and reactions have their own switches', JSON.stringify(after));
} finally { await browser.close(); server.stop(true); }
