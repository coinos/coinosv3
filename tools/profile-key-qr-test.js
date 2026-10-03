// Revealing the public key on a profile shows it as a QR too, and the QR
// really says the npub printed under it.
//
// Run: bun tools/profile-key-qr-test.js
import puppeteer from 'puppeteer-core';
import jsQR from 'jsqr';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5251, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const waitText = async (x, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };

try {
  await page.goto('http://localhost:5251/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('button', 'Create a new wallet');
  await sleep(300);
  await click('button', 'Have an existing seed');
  await sleep(300);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  await waitText('receive', 15000);
  await page.waitForSelector('.header-avatar');
  await page.click('.header-avatar');
  await waitText('Public key');
  check('no QR until the key is asked for', !(await page.$('.npub-qr')));
  await click('button', 'Public key');
  await page.waitForSelector('.npub-qr svg', { timeout: 5000 });
  const npub = await page.evaluate(() => document.querySelector('.npub-box').textContent.trim());
  check('the key is shown', /^npub1[a-z0-9]{58}$/.test(npub), npub);
  const box = await (await page.$('.npub-qr')).boundingBox();
  check('the QR fits a phone screen', box.width <= 420 && box.x >= 0, JSON.stringify(box));
  // read it back the way a camera would: from pixels
  const shot = join(tmpdir(), 'profile-key-qr.png');
  await page.screenshot({ path: shot });
  const px = await page.evaluate(async (sel) => {
    const svg = document.querySelector(sel);
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 440;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 440, 440);
    return Array.from(g.getImageData(0, 0, 440, 440).data);
  }, '.npub-qr svg');
  const read = jsQR(new Uint8ClampedArray(px), 440, 440);
  check('scanning it gives that npub', !!read && read.data === npub, read ? read.data : 'unreadable');
  await click('button', 'Public key');
  await sleep(200);
  check('hiding the key hides the QR', !(await page.$('.npub-qr')));
  console.log(' shot:', shot);
} catch (e) { console.log(e); ok = false; }
await browser.close();
server.stop();
console.log(ok ? '\nall passed' : '\nFAILED');
process.exit(ok ? 0 : 1);
