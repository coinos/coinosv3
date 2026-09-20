// Deterministic browser coverage: real post actions and zap state, fake payment
// settlement. No wallet funds, relays, or payment services are contacted.
// Run: bun tools/zap-feedback-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const app = await Bun.file('src/app.js').text();
const domHelper = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { messagesFeature } from './src/features/messages.js';
import { zapsFeature } from './src/features/zaps.js';
import { arkFeature } from './src/features/ark.js';
${domHelper}
const me = '1'.repeat(64), author = '2'.repeat(64), id = '3'.repeat(64);
const ev = { id, pubkey: author, kind: 1, tags: [], content: 'A little lightning goes a long way.' };
let feature, ark, arkResolve, arkReject, amount = 21, mode = 'pending', calls = 0, toasts = [], loginPk = null;
const ui = { screen: 'wallet', chatOpen: true };
const wallet = { nostr: { pk: me }, loadFeatureState: () => ({}), saveFeatureState() {}, loadArkState() {}, registerCacheExtension() {},
  nostrProfile: async () => { throw new Error('Payment unavailable'); } };
const ctx = { h, ui, wallet, render, toast: (msg) => toasts.push(msg),
  zapDefaultSat: () => amount, setZapDefaultSat: (n) => amount = n,
  brandHeader: () => null,
  testPay: () => new Promise((resolve, reject) => { arkResolve = resolve; arkReject = reject; }),
  showSend: () => { ui.chatOpen = false; },
  hook(name, ...args) {
    if (name === 'zapNpub') { calls++; if (mode === 'ark') ark.testStart(...args); return mode !== 'unavailable'; }
    if (name === 'canLnPay' || name === 'arkReady') return true;
    if (name === 'zapSettled') return feature.zapSettled(...args);
    if (name === 'nostrLoginIdentity') return loginPk ? { pubkey: loginPk } : null;
    return false;
  },
};
function render() {
  if (!feature) return;
  document.querySelector('#actions').replaceChildren(feature.testActions(author, ev, { canZap: true }));
  document.querySelector('#setup').replaceChildren(...(ui.zapSetup ? [feature.testSetup()] : []));
}
feature = messagesFeature(ctx);
ark = arkFeature(ctx);
function receipt(receiptId, pk, sats) {
  feature.testReceipt({ id: receiptId, kind: 9737, pubkey: pk, created_at: Math.floor(Date.now()/1000), tags: [['e', id], ['amount', String(sats)]], content: '' });
}
receipt('base', author, 100); render();
window.test = {
  get calls() { return calls; }, get toasts() { return toasts; }, get amount() { return amount; }, ui, render,
  settle: (ok) => feature.zapSettled(id, ok, amount),
  receipt: () => receipt('ours', me, amount),
  unavailable: () => mode = 'unavailable',
  setup: () => { amount = 0; mode = 'pending'; },
  lightningFailure: () => zapsFeature(ctx).lnZapNpub(author, '', id, 21),
  useArk: () => { mode = 'ark'; amount = 21; },
  finishArk: (ok) => ok ? arkResolve() : arkReject(new Error('Ark payment failed')),
  login: (pk) => loginPk = pk,
  zapper: (pubkey, P) => feature.testZapper({ kind: 9737, pubkey, tags: [['e', id], ['amount', '21'], ...(P ? [['P', P]] : [])] }),
  senderTag: () => ark.testSenderTag(),
};
`;
const bundle = await Bun.build({
  entrypoints: ['zap-test-entry'], target: 'browser',
  plugins: [{ name: 'zap-test', setup(build) {
    build.onResolve({ filter: /^zap-test-entry$/ }, () => ({ path: 'entry', namespace: 'zap-test' }));
    build.onLoad({ filter: /.*/, namespace: 'zap-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
    build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({
      contents: (await Bun.file(path).text()).replace("id: 'messages',", "id: 'messages', testActions: noteActions, testReceipt: noteReceipt, testSetup: zapSetupScreen, testZapper: zapperOf,"), loader: 'js',
    }));
    build.onLoad({ filter: /src\/features\/ark\.js$/ }, async ({ path }) => ({
      contents: (await Bun.file(path).text()).replace("id: 'ark',", `id: 'ark', testSenderTag: zapSenderTag, testStart(...args) {
        connectArk = async () => ({});
        lookupArkZapTarget = async () => ({ status: 'ready', address: 'test' });
        performArkZap = ctx.testPay;
        startNpubPay(...args);
      },`), loader: 'js',
    }));
  } }],
});
assert(bundle.success, bundle.logs.join('\n'));
const css = await Bun.file('src/style.css').text();
const js = await bundle.outputs[0].text();
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { padding: 110px 16px; } article { max-width: 480px; margin: auto; padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 20px; } #actions { margin-top: 30px; }
</style><article data-zap-post="${'3'.repeat(64)}"><strong>@coinos</strong><p>A little lightning goes a long way.</p><div id="actions"></div></article><div id="setup"></div><script type="module">${js}</script>`;
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.zapAudio = { starts: 0, context: null, buffer: null };
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) { super(...args); zapAudio.context = this; }
    createBufferSource() {
      const source = super.createBufferSource(), start = source.start.bind(source);
      source.start = (...args) => { zapAudio.starts++; zapAudio.buffer = source.buffer; return start(...args); };
      return source;
    }
  };
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', (r) => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, value) => { assert(value, name); console.log(' ✓ ' + name); };
const state = () => page.evaluate(() => ({
  tally: document.querySelector('.note-zap').textContent.trim(),
  flying: document.querySelector('.note-zap').classList.contains('flying'),
  effects: document.querySelectorAll('.zap-fx').length, calls: test.calls,
}));
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(server.url.href);
  await page.waitForSelector('.note-zap');
  await page.click('.note-zap');
  let s = await state();
  check('tap starts effect and adds amount before payment settles', s.effects === 1 && s.tally === '121' && s.flying && s.calls === 1);
  check('the entire post trembles on tap', await page.evaluate(() => {
    window.tremble = document.querySelector('article').getAnimations()[0];
    return !!tremble && tremble.effect.getTiming().duration === 360;
  }));
  check('the same tap plays the supplied MP3 clip', await page.evaluate(() => {
    const samples = zapAudio.buffer?.getChannelData(0);
    return zapAudio.starts === 1 && zapAudio.context.state === 'running'
      && zapAudio.buffer.duration > 1.2 && zapAudio.buffer.duration < 1.6
      && samples.some(v => Math.abs(v) > .05)
      && samples.every(v => Number.isFinite(v));
  }));
  await page.evaluate(() => { window.effect = document.querySelector('.zap-fx'); test.render(); });
  s = await state();
  check('rerenders preserve the effect and charge nothing', s.effects === 1 && s.calls === 1 && await page.evaluate(() => effect.isConnected));
  check('rerenders do not repeat the sound', await page.evaluate(() => zapAudio.starts === 1));
  check('rerenders preserve the same post tremble', await page.evaluate(() => document.querySelector('article').getAnimations()[0] === tremble));
  // A zap still in the air is no reason to refuse the next one.
  await page.click('.note-zap');
  s = await state();
  check('a second tap while the first flies stacks another zap', s.effects === 2 && s.calls === 2 && s.tally === '142' && s.flying);
  check('the second tap has its own sound', await page.evaluate(() => zapAudio.starts === 2));
  // Freeze animations at their impact frame for an inspectable mobile preview.
  await page.evaluate(() => document.querySelectorAll('.zap-fx *').forEach((e) => e.getAnimations().forEach((a) => { a.pause(); a.currentTime = 230; })));
  const bounds = await page.$eval('.zap-fx-amount', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  check('amount stays in the mobile viewport', bounds.left >= 0 && bounds.right <= 390);
  await page.screenshot({ path: '/tmp/coinos-zap-feedback.png' });
  await page.evaluate(() => test.settle(false)); await pause(100);
  s = await state();
  check('one failure takes one zap off; the other keeps flying', s.tally === '121' && s.flying && s.effects === 2);
  await page.evaluate(() => test.settle(false)); await pause(100);
  s = await state();
  check('failure restores the previous total without another animation', s.tally === '100' && !s.flying && s.effects === 2);
  check('failure does not play another sound', await page.evaluate(() => zapAudio.starts === 2));
  await pause(1750);
  check('effect cleans up', (await state()).effects === 0);
  check('the post returns to rest without residual transforms', await page.$eval('article', e => !e.getAnimations().length && getComputedStyle(e).transform === 'none'));
  await page.click('.note-zap');
  await page.evaluate(() => { test.receipt(); test.settle(true); }); await pause(100);
  s = await state();
  check('receipt arriving before settlement does not double count', s.tally === '121' && !s.flying && s.effects === 1);
  await pause(1750);
  await page.evaluate(() => test.settle(true)); await pause(100);
  check('late confirmation never replays the effect', (await state()).effects === 0);
  check('confirmation never replays the sound', await page.evaluate(() => zapAudio.starts === 3));
  check('a repeated confirmation does not count the zap again', (await state()).tally === '121');
  await page.evaluate(() => test.unavailable());
  await page.click('.note-zap'); await pause(100);
  check('unavailable payments roll back in place with an error toast', (await state()).tally === '121' && await page.evaluate(() => test.toasts.length === 1 && test.ui.chatOpen));
  await page.evaluate(() => test.lightningFailure()); await pause(100);
  check('Lightning rejection reports its error without navigation', await page.evaluate(() => test.toasts.at(-1).includes('Payment unavailable') && test.ui.chatOpen));
  await pause(1750);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => test.setup());
  await page.click('.note-zap');
  check('first-time setup waits for an amount before animating', (await state()).effects === 0);
  await page.click('#setup .btn-primary');
  check('saving the first amount animates immediately', (await state()).effects === 1);
  check('reduced motion uses a quiet fade without strike or particles', await page.evaluate(() => getComputedStyle(document.querySelector('.zap-fx-bolt')).display === 'none' && getComputedStyle(document.querySelector('.zap-fx-amount')).animationName === 'zap-amount-reduced'));
  check('reduced motion disables the post tremble', await page.$eval('article', e => !e.getAnimations().length));
  await page.evaluate(() => { test.settle(false); test.useArk(); }); await pause(100);
  await page.click('.note-zap'); await pause(100);
  check('Ark payment begins with the optimistic amount', (await state()).tally === '142');
  await page.evaluate(() => test.finishArk(false)); await pause(100);
  check('Ark failure rolls back and toasts without opening Send', (await state()).tally === '121' && await page.evaluate(() => test.ui.chatOpen && !test.ui.arkZap && test.toasts.at(-1).includes('Ark payment failed')));
  await pause(1750);
  await page.click('.note-zap'); await pause(100);
  const toastCount = await page.evaluate(() => test.toasts.length);
  await page.evaluate(() => test.finishArk(true)); await pause(100);
  check('Ark success settles silently without a second effect', (await state()).tally === '142' && !(await state()).flying && (await state()).effects === 1 && await page.evaluate((n) => test.toasts.length === n, toastCount));
  // Holding the bolt opens the amount screen instead of paying.
  const calls = await page.evaluate(() => test.calls);
  const box = await (await page.$('.note-zap')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await pause(650); await page.mouse.up(); await pause(100);
  check('holding the bolt opens the amount screen without paying', await page.evaluate((n) => test.calls === n && document.querySelector('#setup input')?.value === '21', calls));
  await page.evaluate(() => { const i = document.querySelector('#setup input'); i.value = '50'; i.dispatchEvent(new Event('input')); });
  await page.click('#setup .btn-primary'); await pause(100);
  check('saving from the held screen changes the amount and pays nothing', await page.evaluate((n) => test.calls === n && !document.querySelector('#setup input') && test.amount === 50, calls));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await pause(200); await page.mouse.up(); await pause(100);
  check('a short press is still a tap', await page.evaluate((n) => test.calls === n + 1 && !document.querySelector('#setup input'), calls));
  await page.evaluate(() => test.finishArk(true)); await pause(100);
  const silentPage = await browser.newPage();
  silentPage.on('pageerror', e => errors.push(e.message));
  await silentPage.evaluateOnNewDocument(() => {
    window.AudioContext = class { constructor() { throw new Error('Audio disabled'); } };
  });
  await silentPage.setRequestInterception(true);
  silentPage.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
  await silentPage.goto(server.url.href);
  await silentPage.waitForSelector('.note-zap');
  await silentPage.click('.note-zap');
  check('unavailable audio cannot block the zap or animation', await silentPage.evaluate(() => test.calls === 1 && !!document.querySelector('.zap-fx') && document.querySelector('.note-zap').textContent.trim() === '121'));
  await silentPage.close();
  // Ark receipts are signed by the wallet key; the sender tag names the person.
  check('an Ark receipt without a sender tag credits its author', await page.evaluate(() => test.zapper('2'.repeat(64)) === '2'.repeat(64)));
  check('an Ark receipt credits its sender tag over its author', await page.evaluate(() => test.zapper('2'.repeat(64), 'a'.repeat(64)) === 'a'.repeat(64)));
  check('no login identity: receipts carry no sender tag', await page.evaluate(() => test.senderTag().length === 0));
  await page.evaluate(() => test.login('b'.repeat(64)));
  check('a linked login identity is named as the sender', await page.evaluate(() => JSON.stringify(test.senderTag()) === JSON.stringify([['P', 'b'.repeat(64)]])));
  check('our own older receipts read as our login identity', await page.evaluate(() => test.zapper('1'.repeat(64)) === 'b'.repeat(64)));
  check("someone else's untagged receipt still reads as them", await page.evaluate(() => test.zapper('2'.repeat(64)) === '2'.repeat(64)));
  check('no browser errors', errors.length === 0);
} finally { await browser.close(); server.stop(true); }
