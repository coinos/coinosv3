// Real app navigation/forms with a local Ark manager stub; never transfers funds.
// Run: bun tools/ark/cooperative-exit-ui-test.js
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
    window.coopCalls = [];
    window.coopManager = {
      state: { vtxos: [{ id: 'coin-a', amountSat: 12000, state: 'spendable' }, { id: 'coin-b', amountSat: 8000, state: 'spendable' }], actions: [], movements: [] },
      info: { network: 'regtest' }, _tipH: 100,
      vtxos() { return this.state.vtxos; },
      _decoded() { throw new Error('no exit transaction fixture'); },
      refreshFee() { return 0; }, unseenReceives() { return []; }, ackReceives() {},
      address() { return 'test-ark-address'; },
      async send(address, amount) { coopCalls.push({ type: 'split', address, amount }); throw new Error('unexpected split'); },
      async startOffboard(spk, address, ids) {
        coopCalls.push({ type: 'offboard', address, ids: ids || null, script: [...spk] });
        return { txid: '1'.repeat(64), netSat: 19900, feeSat: 100 };
      },
    };
    coopFeature.setManager(coopManager);
    coopApp.ui.screen = 'wallet'; coopApp.ui.tab = 'receive'; coopApp.render();
  }, generateMnemonic(wordlist));
  const manage = async () => {
    await page.evaluate(() => {
      const { ui, render } = coopApp;
      ui.arkOffboarded = null; ui.arkBusy = null; ui.arkError = ''; ui.arkCoinsPage = true;
      render();
    });
    await page.waitForSelector('.coin-table');
  };
  const coopButton = () => page.evaluate(() => [...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('h4')?.textContent === 'Co-operative exit').querySelector('button').click());
  const send = () => page.evaluate(() => [...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('h3')?.textContent === 'Co-operative exit').querySelector('.btn-primary').click());
  const edit = (selector, value) => page.$eval(selector, (e, value) => { e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  // The balance card's gear is the way in: Spending's settings lead with
  // its coins and carry what a unilateral exit costs; the home screen no
  // longer says it under the balance.
  await page.evaluate(() => { window.forceArkReady = true; coopApp.wallet.saveFeatureState('arkDepth', { show: true, exitFee: 4321, key: 'x' }); coopApp.setSpending(); coopApp.render(); });
  const homeText = await page.evaluate(() => document.body.innerText);
  assert(!/Unilateral exit costs/.test(homeText), 'the exit cost is not on the home screen');
  assert(!/Accounts/.test(homeText), 'no Accounts button on the home screen');
  await page.screenshot({ path: '/tmp/gear-home.png' });
  const gears = await page.$$eval('.balance-gear', (es) => es.length);
  assert(gears >= 1, 'the balance card wears a gear');
  const faces = await page.$$eval('.balance-face', (fs) => fs.map((f) => f.innerText.split('\n')[0]));
  assert(faces.some((f) => /spending/i.test(f)), 'a Spending face: ' + JSON.stringify(faces));
  await page.evaluate(() => [...document.querySelectorAll('.balance-face')].find((f) => /spending/i.test(f.innerText.split('\n')[0])).querySelector('.balance-gear').click());
  await page.waitForSelector('.coin-table');
  const st = await page.evaluate(() => ({ nav: coopApp.ui.screen, text: document.body.innerText }));
  assert.equal(st.nav, 'accountSettings');
  assert.match(st.text, /Unilateral exit costs about 4,?321 sats/, 'the exit cost lives on the settings page');
  assert.match(st.text, /Security/); assert.match(st.text, /Lock wallet/); assert.match(st.text, /Recovery phrase/);
  await page.screenshot({ path: '/tmp/gear-settings.png', fullPage: true });
  console.log('✓ The Spending gear opens its settings: coins, the exit cost (gone from home), lock and recovery phrase');
  // its co-operative exit opens the move form on the wallet (it used to flip
  // the Send tab behind the settings page and seem to do nothing)
  await coopButton();
  await page.waitForSelector('input.mono-input', { timeout: 3000 });
  assert.equal(await page.evaluate(() => coopApp.ui.screen), 'wallet');
  assert.equal(await page.$eval('input.mono-input', (e) => e.value), await page.evaluate(() => coopApp.wallet.freshReceive().address));
  assert.deepEqual(await page.evaluate(() => coopCalls), [], 'opening the form never starts an exit');
  console.log('✓ From the Spending settings, the co-operative exit opens its form, prefilled to Savings');
  await page.evaluate(() => { coopApp.ui.arkOffboardSend = null; coopApp.ui.tab = 'receive'; coopApp.render(); });
  // switching between Spending and Savings lands on the Receive page, with
  // that account's address, whatever tab was open
  await page.evaluate(() => { window.forceArkReady = true; coopApp.setSpending(false); coopApp.ui.account = 'spending'; coopApp.render(); });
  for (const [from, to] of [['history', 'savings'], ['send', 'savings']]) {
    await page.evaluate((from) => { coopApp.ui.account = 'spending'; coopApp.ui.tab = from; coopApp.render(); }, from);
    await page.evaluate((to) => coopApp.ctx.setAccount(to), to);
    await new Promise((r) => setTimeout(r, 300));
    const got = await page.evaluate(() => ({ tab: coopApp.ui.tab, account: coopApp.ctx.getAccount(), address: /bcrt1|tark1|ark1/.test(document.querySelector('.tab-pane')?.innerText || '') }));
    assert.deepEqual(got, { tab: 'receive', account: to, address: true }, from + ' → ' + to + ': ' + JSON.stringify(got));
  }
  console.log('✓ Switching between Spending and Savings opens Receive, with that account\'s address');
  await page.evaluate(() => { window.forceArkReady = false; coopApp.wallet.saveFeatureState('arkDepth', null); coopApp.ui.screen = 'wallet'; coopApp.render(); });

  await manage();
  assert.deepEqual(await page.$$eval('.card h4', (es) => es.map((e) => e.textContent)), ['Renewal', 'Co-operative exit', 'Unilateral exit']);
  await coopButton();
  await page.waitForSelector('input.mono-input');
  const savings = await page.evaluate(() => coopApp.wallet.freshReceive().address);
  assert.equal(await page.$eval('input.mono-input', (e) => e.value), savings);
  assert.equal(await page.$eval('input[type="number"]', (e) => e.value), '20000');
  assert.equal(await page.$eval('.card .btn-primary', (e) => e.textContent), 'Send');
  assert.deepEqual(await page.evaluate(() => coopCalls), [], 'opening the form never starts an exit');
  await page.evaluate(() => [...document.querySelectorAll('.card button')].find((b) => b.textContent.includes('Back')).click());
  await page.waitForSelector('.coin-table');
  assert.equal(await page.evaluate(() => coopApp.ui.arkOffboardSend), null);
  console.log('✓ Manage offers a co-operative exit above unilateral exit; Savings and the full balance are prefilled; Back returns to Manage');

  await coopButton();
  for (const address of ['not-an-address', '']) {
    await edit('input.mono-input', address);
    await send();
    assert.match(await page.$eval('.notice.err', (e) => e.textContent), /valid on-chain address/);
  }
  await edit('input.mono-input', savings);
  for (const amount of ['0', '-1', '1.5', '20001']) {
    await edit('input[type="number"]', amount); await send();
    assert.deepEqual(await page.evaluate(() => coopCalls), [], 'invalid inputs must not split or offboard funds');
  }
  await page.evaluate(() => coopFeature.offboard(1000, 'not-an-address'));
  assert(await page.evaluate(() => !!coopApp.ui.arkError), 'internal offboarding also rejects an invalid destination');
  assert.deepEqual(await page.evaluate(() => coopCalls), []);
  console.log('✓ Invalid destinations, zero, fractional and excessive amounts cannot initiate an exit or coin split');

  await edit('input.mono-input', savings);
  await edit('input[type="number"]', '20000'); await send();
  await page.waitForFunction(() => coopApp.ui.arkOffboarded && !coopApp.ui.arkBusy);
  const all = await page.evaluate(() => coopCalls);
  assert.equal(all.length, 1); assert.equal(all[0].type, 'offboard'); assert.equal(all[0].address, savings); assert.equal(all[0].ids, null);
  assert.deepEqual(all[0].script, await page.evaluate(() => [...coopApp.wallet.freshReceive().script]));
  assert.equal(await page.evaluate(() => coopApp.ui.tab), 'receive');
  assert.match(await page.$eval('.card h2', (e) => e.textContent), /On its way/);
  console.log('✓ Sending the prefilled balance offboards every spendable coin to Savings and displays the result');

  await manage(); await coopButton();
  const other = await page.evaluate(() => coopApp.wallet.derive(0, 1).address);
  await edit('input.mono-input', other);
  await edit('input[type="number"]', '12000'); await send();
  await page.waitForFunction(() => coopCalls.length === 2 && !coopApp.ui.arkBusy);
  assert.deepEqual(await page.evaluate(() => ({ address: coopCalls[1].address, ids: coopCalls[1].ids })), { address: other, ids: ['coin-a'] });
  assert.deepEqual(await page.evaluate(() => coopCalls[1].script), await page.evaluate(() => [...coopApp.wallet.derive(0, 1).script]));
  console.log('✓ Editing the destination and amount offboards only the requested amount to the chosen on-chain address');

  await manage(); await coopButton();
  await page.evaluate(() => document.querySelector('.app-nav-button[aria-label="Wallet"]').click());
  assert.equal(await page.evaluate(() => coopApp.ui.arkOffboardSend), null);
  await manage();
  await page.evaluate(() => { coopManager.state.vtxos.forEach((v) => v.state = 'pending'); coopManager.state.actions = [{ type: 'refresh', step: 'submitted', inputIds: ['coin-a', 'coin-b'], inAmountSat: 20000 }]; coopApp.render(); });
  assert(await page.evaluate(() => [...document.querySelectorAll('.card')].find((c) => c.querySelector('h4')?.textContent === 'Co-operative exit').querySelector('button').disabled));
  await page.evaluate(() => {
    const { ui, render } = coopApp;
    ui.arkCoinsPage = null; ui.tab = 'send';
    ui.arkZap = { status: 'ready', pk: '2'.repeat(64), npub: 'recipient', address: 'test', amount: '21', comment: '' };
    render();
  });
  assert.match(await page.$eval('.card .notice.info', (e) => e.textContent), /coins are renewing/);
  await page.evaluate(() => { coopManager.state.actions[0].step = 'done'; coopApp.render(); });
  assert.match(await page.$eval('.card .notice.info', (e) => e.textContent), /not enough in Spending/);
  await page.evaluate(() => { coopManager.state.actions[0].step = 'submitted'; coopManager.state.actions[0].type = 'offboard'; coopApp.render(); });
  assert.match(await page.$eval('.card .notice.info', (e) => e.textContent), /not enough in Spending/);
  await page.evaluate(() => {
    localStorage.setItem('btc-wallet-ark-provider:regtest', 'local');
    coopManager.state.actions[0].type = 'refresh';
    coopApp.ui.arkZap = null;
    coopApp.ui.zap = { status: 'ready', social: true, target: { pk: '2'.repeat(64) }, amount: '21', comment: '', params: { minSendable: 1000, maxSendable: 500000000 } };
    coopApp.render();
  });
  assert.match(await page.$eval('.card .notice.info', (e) => e.textContent), /coins are renewing/);
  assert(await page.$eval('.card .btn-primary', (e) => e.disabled), 'pending renewal funds cannot be paid');
  await page.evaluate(() => { coopManager.state.vtxos.forEach((v) => v.state = 'spendable'); coopManager.state.actions[0].step = 'done'; coopApp.render(); });
  assert.equal(await page.$('.card .notice.info'), null, 'the payment form recovers when the renewal settles');
  assert.equal(await page.$eval('.card .btn-primary', (e) => e.disabled), false);
  console.log('✓ Ark and Lightning forms identify renewal funds without mislabeling other pending funds; they recover once spendable');

  assert.equal(await page.evaluate(() => coopApp.ctx.zapDefaultSat()), 21, 'fresh wallets start with a 21-sat zap preference');
  await page.evaluate(() => coopApp.ctx.setZapDefaultSat(73));
  assert.equal(await page.evaluate(() => coopApp.ctx.zapDefaultSat()), 73, 'a saved preference overrides the default');
  console.log('✓ New users default to 21-sat zaps and explicit preferences are preserved');
  assert.deepEqual(errors, []);
  console.log('✓ Leaving the form clears it; coins already in a renewal cannot be exited again; no browser errors');
} finally { await browser.close(); server.stop(true); }
