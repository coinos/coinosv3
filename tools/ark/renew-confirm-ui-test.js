// Renewing from the coins page asks first: the coins, the fee, what is left
// to spend meanwhile — and says outright when that is nothing. A renewal in
// flight links to its round's transaction once the round has run.
// Real app with a local Ark manager stub holding the ten coins of the
// 2026-10-03 report; nothing is sent anywhere.
// Run: bun tools/ark/renew-confirm-ui-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const bundle = await Bun.build({ entrypoints: ['src/app.js'], target: 'browser', minify: true,
  plugins: [{ name: 'cooperative-exit-test', setup(build) {
    build.onLoad({ filter: /src\/app\.js$/ }, async ({ path }) => ({ loader: 'js', contents: await Bun.file(path).text() + `
window.coopApp = { ui, wallet, ctx, render, enterWallet, get ready() { return !_bootDeciding; },
  setSpending: (on = true) => { const a = activeAccount(); if (a) { if (on) a.kind = 'spending'; else delete a.kind; } } };
` }));
    build.onLoad({ filter: /src\/features\/ark\.js$/ }, async ({ path }) => ({ loader: 'js', contents:
      (await Bun.file(path).text()).replace('    arkReady() { return arkAvailable(); },', '    arkReady() { return window.forceArkReady || arkAvailable(); },').replace("  return {\n    id: 'ark',", `
  window.coopFeature = { setManager: (mgr) => { ark = mgr; }, offboard: doArkOffboard };
  return {\n    id: 'ark',`) }));
    build.onLoad({ filter: /src\/video-compress\.js$/ }, () => ({ loader: 'js', contents: 'export async function compressVideo(f) { return f; }' }));
  } }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === '/'
  ? new Response(html, { headers: { 'Content-Type': 'text/html' } }) : new Response(null, { status: 404 }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844 });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['wss://*', 'ws://*'] });
  await page.setRequestInterception(true);
  page.on('request', (r) => r.url().startsWith(server.url.origin) || r.url().startsWith('data:') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('btc-wallet-network', 'regtest');
    localStorage.setItem('btc-wallet-ark-provider:regtest', 'off');
  });
  await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.coopApp?.ready);
  await page.evaluate(async (mn) => {
    await coopApp.enterWallet(mn, '', { fresh: true, generated: true });
    coopApp.ui.onb = null; localStorage.removeItem('btc-wallet-onb-step');
    coopApp.wallet.scan = async () => {};
    window.renewCalls = [];
    const amounts = [3, 54, 54, 49500, 1000, 1000, 1000, 1000, 1000, 1000];
    const table = [{ thresholdBlocks: 0, ppm: 0 }, { thresholdBlocks: 97, ppm: 250 }, { thresholdBlocks: 199, ppm: 1000 }, { thresholdBlocks: 2161, ppm: 2000 }];
    window.coopManager = {
      state: { vtxos: amounts.map((a, i) => ({ id: 'coin-' + i, amountSat: a, state: 'spendable', expiryHeight: 973921 })), actions: [], movements: [] },
      info: { network: 'regtest', refreshFees: { baseFeeSat: 0, ppmExpiryTable: table } }, _tipH: 969751,
      vtxos() { return this.state.vtxos; },
      _decoded() { throw new Error('no exit transaction fixture'); },
      refreshFee(inputs, tip) {
        let u = 0;
        for (const v of inputs) u += v.amountSat * (table.filter((e) => e.thresholdBlocks <= v.expiryHeight - tip).pop()?.ppm ?? 0);
        return Math.ceil(u / 1e6);
      },
      unseenReceives() { return []; }, ackReceives() {},
      address() { return 'test-ark-address'; },
      async refresh(ids, opts) { renewCalls.push({ ids, opts }); return 'refresh-1'; },
    };
    coopFeature.setManager(coopManager);
    coopApp.ui.screen = 'wallet'; coopApp.ui.tab = 'receive'; coopApp.ui.arkCoinsPage = true; coopApp.render();
  }, generateMnemonic(wordlist));
  await page.waitForSelector('.coin-table');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => page.evaluate(() => document.body.innerText);
  const calls = () => page.evaluate(() => renewCalls);

  assert.match(await page.$eval('.ark-renew-ask', (b) => b.textContent), /112 sats/, 'the button prices all ten coins at 0.2%');
  await page.click('.ark-renew-ask'); await sleep(200);
  assert(await page.$('.ark-renew-confirm'), 'the tap opens a confirmation');
  assert.deepEqual(await calls(), [], 'nothing is renewed by the first tap');
  let tx = await text();
  assert.match(tx, /Renew these coins\?/);
  assert.match(tx, /Coins\s*10/); assert.match(tx, /Amount\s*55,611 sats/); assert.match(tx, /Renewal fee\s*112 sats/);
  assert.match(tx, /Left to spend meanwhile\s*0 sats/);
  assert.match(tx, /This is your whole Spending balance/, 'renewing everything is called out');
  assert.match(tx, /can’t be spent until the round’s transaction confirms/);
  assert.match(tx, /can’t be cancelled/);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  console.log('✓ Renew asks first: 10 coins, 55,611 sats, 112 fee, nothing left to spend — said outright');

  await page.evaluate(() => [...document.querySelectorAll('.ark-renew-confirm button')].find((b) => b.textContent === 'Cancel').click()); await sleep(200);
  assert(!(await page.$('.ark-renew-confirm')) && await page.$('.coin-table'), 'Cancel returns to the coins');
  assert.deepEqual(await calls(), []);
  console.log('✓ Cancel goes back; nothing renewed');

  // leave the big coin out: something stays spendable, no whole-balance warning
  await page.evaluate(() => { coopApp.ui.arkCoinsSel.delete('coin-3'); coopApp.render(); }); await sleep(100);
  await page.click('.ark-renew-ask'); await sleep(200);
  tx = await text();
  assert.match(tx, /Coins\s*9/); assert.match(tx, /Left to spend meanwhile\s*49,500 sats/);
  assert.doesNotMatch(tx, /This is your whole Spending balance/);
  await page.click('.ark-renew-go'); await sleep(300);
  const c = await calls();
  assert.equal(c.length, 1); assert.equal(c[0].ids.length, 9); assert(!c[0].ids.includes('coin-3')); assert.deepEqual(c[0].opts, { manual: true });
  assert(!(await page.$('.ark-renew-confirm')), 'the confirmation closes');
  console.log('✓ With a coin left out it says what stays spendable; confirming renews exactly the selection');

  // a renewal in flight: no link until the round has run, then its transaction
  const txid = 'ab'.repeat(32);
  await page.evaluate(() => {
    const m = coopManager;
    for (const v of m.state.vtxos) if (v.id !== 'coin-3') v.state = 'pending';
    m.state.actions = [{ id: 'refresh-' + Date.now(), type: 'refresh', step: 'submitted', manual: true, inputIds: m.state.vtxos.filter((v) => v.state === 'pending').map((v) => v.id), inAmountSat: 6111, outAmountSat: 6098, feeSat: 13 }];
    coopApp.ui.arkCoinsPage = true; coopApp.render();
  }); await sleep(200);
  assert.match(await text(), /In a round/);
  assert(!(await page.$('.ark-renew-tx')), 'no link before the round has a transaction');
  await page.evaluate((txid) => { coopManager.state.actions[0].fundingTxid = txid; coopApp.render(); }, txid); await sleep(200);
  const href = await page.$eval('.ark-renew-tx', (a) => a.href);
  assert(href.includes(txid), 'the link goes to the round transaction: ' + href);
  console.log('✓ A renewal in flight links to its round\'s transaction once the round has run');
  // ...and the finished renewal's history row carries the same transaction
  await page.evaluate((txid) => {
    const m = coopManager;
    m.state.actions = [];
    for (const v of m.state.vtxos) v.state = 'spendable';
    m.state.movements = [{ id: 'mv-renew', type: 'refresh', amountSat: 6098, feeSat: 13, manual: true, status: 'complete', ts: Date.now(), txid, unlockHash: '22'.repeat(32), inputIds: [] }];
    coopApp.ui.arkCoinsPage = null; coopApp.ui.screen = 'wallet'; coopApp.ui.tab = 'history'; coopApp.ui.arkMoveDetail = 'mv-renew'; coopApp.render();
  }, txid); await sleep(300);
  const detail = await page.evaluate((txid) => ({ shown: document.body.innerText.includes(txid), link: [...document.querySelectorAll('a')].some((a) => a.href.includes(txid)) }), txid);
  if (!detail.shown || !detail.link) console.log('  (detail text: ' + (await text()).slice(0, 300).replace(/\n+/g, ' | ') + ')');
  assert(detail.shown && detail.link, 'the renewal\'s detail shows and links its transaction: ' + JSON.stringify(detail));
  console.log('✓ A finished renewal\'s history detail shows the transaction and links to it');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('\n✅ renewing asks first and shows its transaction');
} finally { await browser.close(); server.stop(true); }
