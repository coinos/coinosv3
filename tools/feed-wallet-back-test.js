// Exercise the real app history: a public feed must survive Wallet -> Back.
// Run: bun tools/feed-wallet-back-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { buildHtml } from '../build.js';
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === '/api/feed'
  ? new Response(null, { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
  await page.goto(server.url.origin + '/feed', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.feed-bottom-nav', { visible: true });
  await page.tap('.feed-nav-button:nth-child(4)');
  await page.waitForFunction(() => !document.querySelector('.feed-bottom-nav'));
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.feed-bottom-nav', { visible: true, timeout: 5000 });
  assert(await page.$eval('.feed-bottom-nav', e => !e.hidden && e.getBoundingClientRect().height > 0));
  assert.equal(await page.evaluate(() => scrollY), 0, 'visible on return without scrolling');
  console.log('✓ Real browser Back restores the public feed and visible navigation after Wallet');
} finally { await browser.close(); server.stop(true); }
