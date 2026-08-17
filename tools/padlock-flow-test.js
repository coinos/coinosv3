// The padlock on a fresh (passwordless) wallet must never cost you your
// session: the set-a-password ask renders over the open wallet, declining it
// lands you exactly where you were, the logo stays a way home, and the
// Wallets list shows only the on-chain wallet until Spending is set up.
// Setting a password locks in place: watch-only home, closed padlock.
// Run: bun tools/padlock-flow-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5236, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 880 });

const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const clickTitle = (t) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((n) => n.title === x); if (b) { b.click(); return true; } return false; }, t);
const body = () => page.evaluate(() => document.body.innerText);
const waitText = async (x, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if ((await body()).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };

try {
  await page.goto('http://localhost:5236/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('button', 'Get started');
  await sleep(500);
  await click('button', 'Import existing');
  await sleep(400);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  check('wallet open', await waitText('receive'));
  await sleep(2000);

  console.log('\n[the Wallets list before opting into Spending]');
  await click('button', 'Wallets');
  await sleep(600);
  let txt = await body();
  check('shows the on-chain wallet', /savings/i.test(txt), txt.slice(0, 140).replace(/\n+/g, ' | '));
  check('and no un-asked-for Spending wallet', !/spending/i.test(txt), txt.slice(0, 140).replace(/\n+/g, ' | '));
  await click('button', 'Back');
  await sleep(500);
  check('back home', await waitText('receive'));

  console.log('\n[padlock with no password: declining is free]');
  await clickTitle('Lock wallet');
  await sleep(500);
  txt = await body();
  check('it asks for a password in place', (await page.$$('input[type=password]')).length >= 2, txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('with a way to decline', /not now/i.test(txt));
  await click('button', 'Not now');
  await sleep(600);
  txt = await body();
  check('declining lands back home', /receive/i.test(txt) && /balance/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('not on the wallets list', !/add wallet|clear all/i.test(txt));

  console.log('\n[the logo still means home]');
  await page.evaluate(() => document.querySelector('.brand')?.click());
  await sleep(600);
  txt = await body();
  check('logo goes home, not to a password prompt', /receive/i.test(txt) && !/unlock saved|enter your password/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));

  console.log('\n[setting a password locks in place]');
  await clickTitle('Lock wallet');
  await sleep(500);
  const fields = await page.$$('input[type=password]');
  check('password form is up', fields.length >= 2, `${fields.length} field(s)`);
  await fields[0].type('hunter22');
  await fields[1].type('hunter22');
  await click('button', 'Save');
  await sleep(1200);
  txt = await body();
  check('still home (watch-only), not signed out', /receive/i.test(txt) && /balance/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  const closed = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.title && /unlock/i.test(b.title)));
  check('padlock is closed', closed);

  console.log('\n[and the padlock now asks for the password]');
  await clickTitle('Unlock');
  await sleep(600);
  txt = await body();
  check('unlock needs the password', /password/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
} catch (e) {
  check('run completed', false, e.message);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(fails ? '\n❌ failures above' : '\n✅ padlock flow behaves');
process.exit(fails ? 1 : 0);
