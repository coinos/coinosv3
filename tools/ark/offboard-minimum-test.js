// The on-chain send from Spending states the co-operative fee and minimum up
// front, refuses a balance below it in words, and keeps the unilateral-exit
// note for when the ASP actually failed to co-operate. Local manager stub.
// Run: bun tools/ark/offboard-minimum-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const bundle = await Bun.build({ entrypoints: ['src/app.js'], target: 'browser', minify: true,
  plugins: [{ name: 'cooperative-exit-test', setup(build) {
    build.onLoad({ filter: /src\/app\.js$/ }, async ({ path }) => ({ loader: 'js', contents: await Bun.file(path).text() + `
window.coopApp = { ui, wallet, ctx, render, enterWallet, get ready() { return !_bootDeciding; } };
` }));
    build.onLoad({ filter: /src\/features\/ark\.js$/ }, async ({ path }) => ({ loader: 'js', contents:
      (await Bun.file(path).text()).replace("  return {\n    id: 'ark',", `
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
      state: { vtxos: [{ id: 'coin-a', amountSat: 1000, state: 'spendable' }], actions: [], movements: [] },
      async offboardQuote() { coopCalls.push({ type: 'quote' }); return { chainSat: 736, serviceSat: 204, totalSat: 940, minSat: 1270 }; },
      info: { network: 'regtest' }, _tipH: 100,
      vtxos() { return this.state.vtxos; },
      _decoded() { throw new Error('no exit transaction fixture'); },
      refreshFee() { return 0; }, unseenReceives() { return []; }, ackReceives() {},
      address() { return 'test-ark-address'; },
      async send(address, amount) { coopCalls.push({ type: 'split', address, amount }); throw new Error('unexpected split'); },
      async startOffboard(spk, address, ids) {
        coopCalls.push({ type: 'offboard', address, ids: ids || null });
        throw window.coopFail || new Error('unexpected offboard');
      },
    };
    coopFeature.setManager(coopManager);
    coopApp.ui.screen = 'wallet'; coopApp.ui.tab = 'receive'; coopApp.render();
  }, generateMnemonic(wordlist));
  const open = async () => {
    await page.evaluate(() => {
      const { ui, render } = coopApp;
      ui.arkOffboarded = null; ui.arkBusy = null; ui.arkError = ''; ui.arkCoopFailed = false;
      ui.screen = 'wallet'; ui.tab = 'send';
      ui.arkOffboardSend = { address: coopApp.wallet.derive(0, 1).address, amount: '' };
      render();
    });
    await page.waitForSelector('input.mono-input');
  };
  const card = () => page.evaluate(() => {
    const c = document.querySelector('input.mono-input').closest('.card');
    return { uni: /trustless|didn’t cooperate/i.test(c.innerText), text: c.innerText, sendDisabled: c.querySelector('.btn-primary').disabled, err: c.querySelector('.notice.err')?.textContent || '' };
  });
  await open();
  await page.waitForFunction(() => /Fee about/.test(document.querySelector('input.mono-input').closest('.card').innerText));
  let c = await card();
  assert.match(c.text, /Fee about 940 sats right now \(736 mining \+ 204 coinos\), so it needs at least 1,270 sats/);
  assert.match(c.text, /Your 1,000 sats are below the 1,270-sat minimum/);
  assert(c.sendDisabled, 'send is off below the minimum');
  assert(!c.uni, 'no unilateral-exit talk for a balance that is merely small');
  console.log('✓ the co-operative fee and minimum show before any tap; a balance below it disables Send and points to Lightning');

  // the manager's own guard (fees moved since the quote): plain words, no fallback
  await page.evaluate(() => { window.coopFail = Object.assign(new Error('ark balance too small to offboard after fees'), { tooSmall: true, feeSat: 950, minSat: 1280 }); });
  await page.evaluate(() => coopFeature.offboard(0, coopApp.wallet.derive(0, 1).address));
  c = await card();
  assert.equal(c.err, 'Sending on-chain needs at least 1,280 sats right now (the fee is about 950).');
  assert(!c.uni && !/ark balance too small/.test(c.text));
  console.log('✓ a too-small offboard reads in words and does not offer the unilateral exit');

  // the ASP refusing is what the unilateral exit is for
  await page.evaluate(() => { window.coopFail = new Error('server unavailable'); });
  await page.evaluate(() => coopFeature.offboard(0, coopApp.wallet.derive(0, 1).address));
  c = await card();
  assert.equal(c.err, 'server unavailable');
  assert(c.uni, 'a failed co-operation still explains the unilateral exit: ' + c.text);
  console.log('✓ a failed co-operation still shows the unilateral-exit note');
  assert.deepEqual(errors, []);
} finally { await browser.close(); server.stop(true); }
