// "Log out" locks; only "Delete all" deletes.
//
// Wallets save themselves to this device under an empty password unless the
// user sets one. Logging out of a passwordless vault offers a password ONCE
// (ever), then drops to the wallet list — everything saved, one tap back in.
// The padlock is the counterpart with its own rules (see padlock-flow-test).
//
// Run: bun tools/lock-wallet-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + String(d).slice(0, 160) : ''}`); if (!c) fails++; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5235, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 880 });
const body = () => page.evaluate(() => document.body.innerText);
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const waitText = async (x, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if ((await body()).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };
const vaultSize = () => page.evaluate(() => (localStorage.getItem('btc-wallet-vault') || '').length);
// Log out lives on the own-profile page behind the header avatar.
const logout = async () => {
  await page.evaluate(() => document.querySelector('.header-avatar')?.click());
  await sleep(800);
  await click('button', 'Log out'); // opens the confirm popup
  await sleep(500);
  await page.evaluate(() => document.querySelector('.confirm-pop .btn-primary')?.click());
  await sleep(1200);
};
const enterSavings = async () => {
  await click('button', 'Savings');
  await sleep(1500);
  return waitText('receive');
};

try {
  await page.goto('http://localhost:5235/', { waitUntil: 'domcontentloaded' });
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
  await sleep(2500);
  const savedBytes = await vaultSize();
  check('it saved itself to the device', savedBytes > 0, `${savedBytes} bytes of vault`);

  console.log('\n[logging out with no password set]');
  await logout();
  let txt = await body();
  check('it offers a password once', /protect this device/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('and does not force one', /not now/i.test(txt));
  await click('button', 'Not now');
  await sleep(800);
  txt = await body();
  check('declining logs out anyway', !/protect this device/i.test(txt));
  check('no password is demanded', !/enter your password|unlock saved wallets/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('the saved wallet is still there', (await vaultSize()) === savedBytes);
  check('and it is offered back', /savings/i.test(txt), txt.slice(0, 140).replace(/\n+/g, ' | '));
  const listed = await page.evaluate(() => [...document.querySelectorAll('button')].map((e) => e.textContent.trim()).filter((x) => /^[●○] Savings/.test(x)));
  check('and only once — no phantom duplicate', listed.length === 1, JSON.stringify(listed));

  console.log('\n[the offer is not a nag]');
  check('one tap returns to the wallet', await enterSavings());
  await logout();
  txt = await body();
  check('it does not ask a second time', !/protect this device/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('logout means the front door', /create new|get started|sign in/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('and a saved passwordless wallet is one reload away', await waitText('receive'));
  await sleep(1000);

  console.log('\n[the padlock still asks — locking needs a password]');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((n) => n.title === 'Lock wallet'); if (b) b.click(); });
  await sleep(600);
  txt = await body();
  check('padlock asks even after "Not now"', /protect this device/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  await click('button', 'Not now');
  await sleep(600);
  check('and declining lands home', await waitText('receive'));

  console.log('\n[now with a password]');
  await click('button', 'Wallets');
  await sleep(800);
  await click('button', 'Change password');
  await sleep(800);
  const fields = await page.$$('input[type=password]');
  check('the change-password form is up', fields.length >= 3, `${fields.length} field(s)`);
  // current (empty) / new / confirm
  await fields[fields.length - 2].type('hunter22');
  await fields[fields.length - 1].type('hunter22');
  await click('button', 'Save');
  const pwSet = await waitText('password changed', 8000);
  check('a password is actually set', pwSet, (await body()).slice(0, 120).replace(/\n+/g, ' | '));

  await click('button', 'Back');
  await sleep(1200);
  check('back in the wallet', await waitText('receive'));
  await logout();
  txt = await body();
  check('logout is still the front door', /create new|get started|sign in/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  check('the wallet is still saved', (await vaultSize()) > 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(800);
  txt = await body();
  check('now re-entry asks for the password', /unlock saved wallets|enter your password/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
  const pwField = await page.$('input[type=password]');
  await pwField.type('hunter22');
  await click('button', 'Unlock');
  check('the password opens it', await waitText('receive'));
  await sleep(1000);

  console.log('\n[log out & forget is the other exit]');
  await page.evaluate(() => document.querySelector('.header-avatar')?.click());
  await sleep(800);
  txt = await body();
  await click('button', 'Log out'); // the popup carries both exits
  await sleep(500);
  txt = await body();
  check('the popup offers the drastic exit too', /forget all data/i.test(txt), txt.slice(0, 160).replace(/\n+/g, ' | '));
  await click('button', 'forget all data');
  await sleep(600);
  txt = await body();
  check('it routes through the Delete-all warning', /delete all/i.test(txt) && /lost for good/i.test(txt), txt.slice(0, 160).replace(/\n+/g, ' | '));
  await click('button', 'Back');
  await sleep(600);
  check('backing out deletes nothing', (await vaultSize()) > 0);

  console.log('\n[delete all is the destructive one]');
  await click('button', 'Wallets');
  await sleep(800);
  await click('button', 'Delete all');
  await sleep(600);
  txt = await body();
  check('it warns first', /delete all/i.test(txt) && /(delete|remove|erase|wipe|lose)/i.test(txt), txt.slice(0, 160).replace(/\n+/g, ' | '));
  await page.evaluate(() => { const b = [...document.querySelectorAll('.btn-primary')].find((e) => /delete all/i.test(e.textContent)); if (b) b.click(); });
  await sleep(1200);
  txt = await body();
  check('everything is gone', (await vaultSize()) === 0);
  check('back at the start page', /get started/i.test(txt), txt.slice(0, 120).replace(/\n+/g, ' | '));
} catch (e) {
  check('run completed', false, e.message);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(fails ? '\n❌ failures above' : '\n✅ log out locks, delete all deletes');
process.exit(fails ? 1 : 0);
