// The Send form's recipient: one line that grows to show a whole address
// (it used to be repeated in small type underneath), and the history list
// steps aside once you're on to the amount.
// Run: bun tools/send-dest-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { p2tr } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const taproot = p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, REGTEST).address; // 64 characters
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase() === x || n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const field = () => page.$eval('textarea.send-dest', (e) => ({ rows: e.rows, h: e.clientHeight, sh: e.scrollHeight, v: e.value, lines: Math.round((e.clientHeight - parseFloat(getComputedStyle(e).paddingTop) - parseFloat(getComputedStyle(e).paddingBottom)) / parseFloat(getComputedStyle(e).lineHeight)) }));
const history = () => page.evaluate(() => [...document.querySelectorAll('.tab-pane .small.faint')].some((e) => /^history$/i.test(e.textContent.trim())));
try {
  for (const width of [390, 1280]) {
    await page.setViewport({ width, height: 844 });
    await page.goto(server.url.origin, { waitUntil: 'domcontentloaded' });
    if (width === 390) {
      await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
      await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
      await click('create a new wallet'); await sleep(500); await click('to import'); await sleep(400);
      await page.waitForSelector('textarea'); await page.type('textarea', generateMnemonic(wordlist)); await click('open wallet');
    }
    for (let i = 0; i < 60 && !(await page.evaluate(() => /receive/i.test(document.body.innerText))); i++) await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.tabs button, [role=tab], button')].find((b) => b.textContent.trim() === 'Send')?.click());
    await page.waitForSelector('textarea.send-dest', { timeout: 10000 });
    console.log(`[${width}px]`);
    let f = await field();
    if (process.env.SHOT) { const r = await page.$eval('textarea.send-dest', (e) => { const b = e.closest('.input-group').getBoundingClientRect(); return [b.x, b.y, b.width, b.height, e.clientWidth]; }); console.log('field width', r[4]); await page.screenshot({ path: process.env.SHOT + '-' + width + '.png', clip: { x: r[0] - 6, y: r[1] - 6, width: r[2] + 12, height: r[3] + 12 } }); }
    check('an empty recipient shows its whole hint, no taller', f.sh <= f.h + 1 && f.rows <= (width > 600 ? 1 : 2), JSON.stringify(f));
    check('...and the history is there below the form', await history());
    await page.focus('textarea.send-dest');
    await page.keyboard.type(taproot, { delay: 0 }); await sleep(600);
    f = await field();
    check('a 64-character address is all in view, the field grown to fit', f.v === taproot && f.sh <= f.h + 1 && (width > 600 || f.lines >= 2), JSON.stringify(f));
    check('nothing repeats it underneath', !(await page.$('.addr-check')));
    check('with the amount showing, the history steps aside', !!(await page.$('input[type=number]')) && !(await history()));
    await page.keyboard.press('Enter'); await sleep(100);
    check('Enter does not break the line', (await field()).v === taproot);
    // clear it: back to the recipient step, history back
    await page.$eval('textarea.send-dest', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(600);
    f = await field();
    check('cleared, it shrinks back to its hint', f.rows <= (width > 600 ? 1 : 2) && f.sh <= f.h + 1, JSON.stringify(f));
    check('...and the history returns', await history());
  }
  check('no page errors', errs.length === 0, errs.join('; ').slice(0, 300));
} catch (e) {
  check('run completed', false, e.stack);
} finally {
  await browser.close(); server.stop(true);
}
console.log(ok ? '\n✅ the recipient grows to fit; the history steps aside while sending' : '\n❌ failures above');
process.exit(ok ? 0 : 1);
