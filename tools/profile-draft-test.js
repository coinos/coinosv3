// The actual profile editor must keep its draft across repeated refreshes
// without adding a browser-history entry for each keystroke.
// Run: bun tools/profile-draft-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { seedPubkey } from '../src/nostr.js';
import { buildHtml } from '../build.js';

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const origin = `http://localhost:${server.port}`;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const click = async label => {
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent.trim().toLowerCase() === label.toLowerCase()), {}, label);
  const button = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === label.toLowerCase()), label);
  await button.asElement().click();
  await button.dispose();
  await new Promise(r => setTimeout(r, 400));
};
const fields = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('label.field')]
  .filter(l => l.querySelector('input,textarea')).map(l => [l.querySelector('.lab')?.textContent, l.querySelector('input,textarea').value])));
const edit = (label, value) => page.evaluate(({ label, value }) => {
  const el = [...document.querySelectorAll('label.field')].find(l => l.querySelector('.lab')?.textContent === label)?.querySelector('input,textarea');
  if (!el) throw new Error('missing field: ' + label);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { label, value });
const editor = () => page.waitForSelector('label.field textarea');
try {
  // Keep this generated test identity local: no relay traffic or API writes.
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['wss://*', 'ws://*'] });
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith(origin) || req.url().startsWith('data:') ? req.continue() : req.abort());
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await click('Get started');
  await click('Import existing');
  await page.waitForSelector('textarea');
  const mnemonic = generateMnemonic(wordlist);
  await page.type('textarea', mnemonic);
  await click('Open wallet');
  await page.waitForSelector('.header-avatar');
  const pk = seedPubkey(mnemonic, '', 0);
  await page.evaluate(pk => {
    for (const base of Object.keys(localStorage).filter(k => /^btc-wallet-cache:[0-9a-f]+$/.test(k))) {
      localStorage.setItem(base + ':profiles', JSON.stringify({ [pk]: { name: 'Published name', t: Date.now() } }));
      localStorage.setItem(base + ':names', JSON.stringify({ name: 'published', domain: 'coinos.io' }));
    }
  }, pk);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header-avatar');
  await page.click('.header-avatar');
  await click('Edit profile');
  await editor();
  const historyLength = await page.evaluate(() => history.length);
  const initial = await fields();
  const displayLabel = Object.keys(initial).find(k => /display|^name$/i.test(k));
  await edit(displayLabel, 'Draft ✨');
  await edit('About', 'An unfinished bio\nwith a second line');
  await edit('Picture URL', origin + '/draft-picture.webp');
  await edit('Cover photo URL', origin + '/draft-cover.webp');
  await edit('Username', 'draftusername');
  const expected = await fields();
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await editor();
  assert.deepEqual(await fields(), expected);
  console.log('✓ refreshing keeps the editor and all five draft fields');

  await edit('About', '');
  await edit('Username', 'secondedit');
  const second = await fields();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await editor();
  assert.deepEqual(await fields(), second);
  console.log('✓ edits after restoration and intentionally empty fields survive another refresh');

  await click('Cancel');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Edit profile'));
  assert.equal(await page.$('label.field textarea'), null);
  await click('Edit profile');
  await editor();
  assert.equal((await fields()).Username, 'published');
  assert.equal((await fields())[displayLabel], 'Published name');
  console.log('✓ cancel leaves the editor closed after refresh and discards the draft');

  await page.evaluate(() => {
    const st = history.state;
    st.nav.profilePk = 'b'.repeat(64);
    history.replaceState(st, '');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.profile-avatar');
  assert.equal(await page.$('label.field textarea'), null);
  assert.deepEqual(errors, []);
  console.log('✓ a restored editor cannot appear on another identity’s profile');
} catch (err) {
  console.log('Profile test screen:', (await page.evaluate(() => document.body.innerText)).slice(0, 1600));
  console.log('Page errors:', errors);
  throw err;
} finally {
  await browser.close();
  server.stop(true);
}
