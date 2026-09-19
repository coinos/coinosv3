// A watch-only account without remembered Nostr metadata must still offer
// account switching and logout. Uses an unfunded, generated public key only.
// Run: bun tools/account-access-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { accountXpubFor, cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';

const xpub = accountXpubFor({ mnemonic: generateMnemonic(wordlist) });
const html = await buildHtml({ minify: false, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack));
await page.setRequestInterception(true);
page.on('request', (r) => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
const check = (name, value) => { assert(value, name); console.log(' ✓ ' + name); };
const click = (text) => page.evaluate((label) => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  if (!button) throw new Error('Missing button: ' + label);
  button.click();
}, text);
try {
  await page.goto(server.url.href);
  await page.evaluate((xpub) => {
    localStorage.setItem('btc-wallet-watch', JSON.stringify([{ id: 'test-watch', label: 'Saved wallet', xpub }]));
  }, xpub);
  await page.reload();
  await page.waitForSelector('.header-avatar');
  check('fresh local account defaults to mainnet', await page.evaluate(() => JSON.parse(localStorage.getItem('btc-wallet-watch'))[0].network === 'mainnet'));
  check('anonymous avatar has an accessible Accounts label', await page.$eval('.header-avatar', (e) => e.getAttribute('aria-label') === 'Accounts'));
  await page.click('.header-avatar');
  check('avatar opens Accounts with sign-in and logout', await page.evaluate(() => ['Accounts', 'Sign into another account', 'Log out'].every((s) => document.body.innerText.includes(s))));
  const saved = await page.evaluate(() => localStorage.getItem('btc-wallet-watch'));
  await click('Sign into another account');
  // Expand the Nostr login card without supplying a private key.
  await click('Sign in with Nostr');
  await page.waitForSelector('input[placeholder="nsec, private key, or bunker://…"]');
  check('Nostr key sign-in is reachable without deleting the old wallet', await page.evaluate((saved) => localStorage.getItem('btc-wallet-watch') === saved, saved));
  await click('← Back');
  await page.waitForSelector('.header-avatar');
  await page.click('.header-avatar');
  await click('Log out');
  check('logout asks before ending the session', await page.evaluate(() => document.body.innerText.includes('Your accounts stay saved on this device.')));
  await click('Log out');
  check('logout reaches the sign-in screen and retains the saved wallet', await page.evaluate((saved) => !document.querySelector('.header-avatar') && document.body.innerText.includes('Sign in with Nostr') && localStorage.getItem('btc-wallet-watch') === saved, saved));
  // Remember a public login identity on the watch-only account so every
  // header destination is available, without supplying a private key.
  await page.evaluate(({ key }) => {
    localStorage.setItem(key + ':nostrlogin', JSON.stringify({ pubkey: 'a'.repeat(64), type: 'extension' }));
    history.replaceState(null, '');
  }, { key: cacheKeyFor(xpub) });
  await page.reload();
  await page.waitForSelector('[aria-label="Messages"]');
  await click('Accounts');
  const onAccounts = () => page.evaluate(() => [...document.querySelectorAll('h3')].some(e => e.textContent === 'Accounts'));
  for (const label of ['Search', 'Messages', 'Your profile', 'Settings']) {
    check(label + ' starts on Accounts', await onAccounts());
    await page.click('[aria-label="' + label + '"]');
    check(label + ' opens from Accounts', await page.evaluate(label => {
      const nav = history.state.nav;
      return nav.screen === 'wallet' && ![...document.querySelectorAll('h3')].some(e => e.textContent === 'Accounts')
        && (label === 'Search' ? !!document.querySelector('.user-search-input')
          : label === 'Messages' ? nav.chatOpen && nav.msgView === 'home'
          : label === 'Your profile' ? !!document.querySelector('.npub-box') && nav.profilePk === 'a'.repeat(64)
          : nav.tab === 'settings');
    }, label));
    await page.goBack();
    await page.waitForFunction(() => [...document.querySelectorAll('h3')].some(e => e.textContent === 'Accounts'));
    check('Back returns from ' + label + ' to Accounts', await onAccounts());
  }
  await page.click('[aria-label="Lock wallet"]');
  check('Lock opens its password prompt from Accounts', await page.evaluate(() => !!document.querySelector('input[type="password"]')));
  await click('Not now');
  await page.click('.brand');
  check('the logo returns to the wallet', await page.evaluate(() => history.state.nav.screen === 'wallet' && ![...document.querySelectorAll('h3')].some(e => e.textContent === 'Accounts')));
  assert.deepEqual(errors, []);
  check('no browser errors', true);
} finally { await browser.close(); server.stop(true); }
