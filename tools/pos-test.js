// Point of sale: amount → tip prompt → one invoice for the total → paid, with
// the bill and the tip counted apart. The Ark side is faked: no relays, no
// server, no money. Run: bun tools/pos-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const app = await Bun.file('src/app.js').text();
const domHelper = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { posFeature } from './src/features/pos.js';
${domHelper}
const state = {};
const ui = { screen: 'wallet' };
let watch = null, cancelled = [], invoices = 0;
const wallet = { loadFeatureState: (k, d) => (k in state ? state[k] : d), saveFeatureState: (k, v) => { state[k] = JSON.parse(JSON.stringify(v)); } };
const ctx = {
  h, ui, wallet, render, toast: (m) => (window.toasts = (window.toasts || [])).push(m), copy: (x) => (window.copied = x),
  fmtAmount: (n) => Number(n).toLocaleString('en-US'), unitLabel: () => 'sats', unitTag: () => h('span', { class: 'unit-tag' }, 'sats'),
  parseAmount: (v) => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? Math.round(n) : null; }, getUnit: () => window.__unit || 'sats',
  brandHeader: () => null,
  hook(name, ...a) {
    if (name === 'arkReady') return true;
    if (name === 'arkLnInvoice') { invoices++; return Promise.resolve({ id: 'ln' + invoices, invoice: 'lnbc' + a[0] + 'n1testinvoice' + invoices, amountSat: a[0] }); }
    if (name === 'arkLnWatch') { watch = { id: a[0], cb: a[1] }; return true; }
    if (name === 'arkLnUnwatch') { if (watch && watch.id === a[0]) watch = null; return true; }
    if (name === 'arkLnCancel') { cancelled.push(a[0]); return Promise.resolve(true); }
    return null;
  },
};
const feature = posFeature(ctx);
function render() { document.querySelector('#app').replaceChildren(feature.screenView() || h('div', { id: 'closed' }, 'closed')); }
window.test = { open: () => { feature.openPos(); }, init: () => { feature.init(); render(); }, settle: (ok) => { const w = watch; watch = null; w.cb({ step: ok ? 'done' : 'failed' }); }, get watch() { return watch && watch.id; }, get cancelled() { return cancelled; }, get sales() { return (state.pos || {}).sales || []; }, ui };
render();
`;
const bundle = await Bun.build({
  entrypoints: ['pos-test-entry'], target: 'browser',
  plugins: [{ name: 'pos-test', setup(build) {
    build.onResolve({ filter: /^pos-test-entry$/ }, () => ({ path: 'entry', namespace: 'pos-test' }));
    build.onLoad({ filter: /.*/, namespace: 'pos-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  } }],
});
assert(bundle.success, bundle.logs.join('\n'));
const css = await Bun.file('src/style.css').text();
const js = await bundle.outputs[0].text();
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="app"></div><script type="module">${js}</script>`;
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, value, detail = '') => { assert(value, name + (detail ? ' — ' + detail : '')); console.log(' ✓ ' + name); };
const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
const click = (label) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((n) => (n.querySelector('.pos-tip-label') || n).textContent.trim() === x); if (!b) return false; b.click(); return true; }, label);
// the harness repaints by replacing nodes (the app morphs in place), so a
// field is filled in one go rather than keystroke by keystroke
const type = (sel, v) => page.evaluate(([s, val]) => { const i = document.querySelector(s); i.value = val; i.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.href);
  await page.waitForSelector('#closed');
  await page.evaluate(() => test.open()); await pause(50);
  check('the point of sale opens on the amount screen', /Point of sale/.test(await text()) && !!(await page.$('.pos-amount')));
  await click('Charge'); await pause(50);
  check('charging nothing asks for an amount', /Enter an amount first/.test(await text()));
  for (const k of ['1', '0', '0', '0']) await click(k);
  check('the on-screen pad fills the amount field', await page.$eval('.pos-amount', (i) => i.value) === '1000');
  const hitDel = await click('\u232b'); const afterDel = await page.$eval('.pos-amount', (i) => i.value); await click('0');
  check('backspace edits the same field', await page.$eval('.pos-amount', (i) => i.value) === '1000', JSON.stringify({ hitDel, afterDel }));
  await type('input[placeholder="Note (optional)"]', 'Table 4');
  await click('Charge'); await pause(50);
  check('the tip prompt shows the bill and the tip choices', /Your bill 1,000 sats/.test(await text()) && /10%.*15%.*20%.*Other.*No tip/.test(await text()));
  await click('15%'); await pause(50);
  check('a percentage shows the total', /Total 1,150 sats/.test(await text()));
  await click('Continue'); await pause(100);
  check('one invoice is made for bill plus tip', await page.evaluate(() => test.watch === 'ln1') && /1,150 sats/.test(await text()) && /Bill 1,000 \+ tip 150 sats/.test(await text()) && !!(await page.$('.pos-qr svg')));
  await click('Copy');
  check('copy hands over the invoice', await page.evaluate(() => window.copied === 'lnbc1150n1testinvoice1'));
  await page.evaluate(() => test.settle(true)); await pause(50);
  check('settlement shows Paid with the breakdown', /Paid/.test(await text()) && /Bill 1,000 \+ tip 150 sats/.test(await text()));
  await click('New sale'); await pause(50);
  check('the ledger keeps the bill and the tip apart', /Bills 1,000 sats/.test(await text()) && /Tips 150 sats/.test(await text()) && /Total 1,150 sats/.test(await text()) && /Table 4/.test(await text()));

  console.log('\n[a custom tip, then a cancelled sale]');
  await type('.pos-amount', '2000'); await click('Charge'); await pause(50);
  await click('Other'); await pause(50);
  await click('5'); await click('0'); await pause(50);
  check('a custom tip adds what was typed', /Total 2,050 sats/.test(await text()));
  await click('Continue'); await pause(100);
  await click('Cancel'); await pause(50);
  check('cancelling voids the sale and the invoice', await page.evaluate(() => test.cancelled.includes('ln2') && test.sales.find((s) => s.billSat === 2000).status === 'void') && /cancelled/.test(await text()));
  check('a cancelled sale does not count', /Bills 1,000 sats/.test(await text()) && /Tips 150 sats/.test(await text()));

  console.log('\n[no tip prompt]');
  await page.click('input[type=checkbox]'); await pause(50);
  await type('.pos-amount', '300'); await click('Charge'); await pause(100);
  check('with the prompt off, Charge goes straight to the invoice', /Scan to pay/.test(await text()) && /300 sats/.test(await text()) && await page.evaluate(() => test.watch === 'ln3'));
  await page.evaluate(() => test.settle(false)); await pause(50);
  check('an expired invoice returns to the amount screen and says so', /That invoice expired/.test(await text()));
  console.log('\n[a till in dollars]');
  await page.evaluate(() => { window.__unit = 'fiat'; test.ui.pos = null; test.open(); }); await pause(50);
  await click('5');
  check('one digit is cents', await page.$eval('.pos-amount', (i) => i.value) === '0.05');
  await click('\u232b'); for (const k of ['2', '7', '7']) await click(k);
  check('digits shift in from the right', await page.$eval('.pos-amount', (i) => i.value) === '2.77');
  await click('\u232b'); await click('\u232b'); await click('\u232b'); for (const k of ['5', '5', '8', '8']) await click(k);
  check('...to any length', await page.$eval('.pos-amount', (i) => i.value) === '55.88');
  await click('\u232b'); await click('\u232b'); await click('00');
  check('the dot key is 00 in a currency', await page.$eval('.pos-amount', (i) => i.value) === '55.00');
  await page.evaluate(() => { window.__unit = 'sats'; });
  await page.evaluate(() => { test.ui.pos = null; test.ui.posAtBoot = true; test.init(); }); await pause(50);
  check('the /pos link opens the till once a wallet is up', !!(await page.$('.pos-amount')));
  check('no browser errors', errors.length === 0);
} finally { await browser.close(); server.stop(true); }
console.log('\n✅ point of sale');
