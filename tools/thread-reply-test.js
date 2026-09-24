// Real reply buttons/composer with controlled relay replies and no publishing.
// Run: bun tools/thread-reply-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { messagesFeature } from './src/features/messages.js';
import { createThreadStore } from './src/thread-cache.js';
${dom}
const author = 'a'.repeat(64), mine = 'b'.repeat(64), rootId = 'c'.repeat(64);
const root = { id: rootId, pubkey: author, kind: 1, content: 'Root post', tags: [], created_at: 1 };
const reply = { ...root, id: 'd'.repeat(64), content: 'The reply you tapped', tags: [['e', rootId, '', 'root']], created_at: 2 };
const other = { ...reply, id: 'e'.repeat(64), content: 'Another reply not returned by the relay', created_at: 3 };
const ui = { screen: 'wallet' }, waiting = [];
window.sent = [];
window.query = filter => filter.kinds?.[0] === 1 && (filter.ids || filter['#e']) ? new Promise(resolve => waiting.push({ filter, resolve })) : Promise.resolve([]);
const signer = { signEvent: async e => ({ ...e, id: 'f'.repeat(64), pubkey: mine }) };
let feature;
const wallet = { loaded: true, nostrRelays: () => [], loadFeatureState: (k, d) => d, saveFeatureState() {} };
function render() {
  if (!feature) return;
  document.querySelector('#app').replaceChildren(feature.screenView() || feature.row(author, reply, 'Someone'));
}
feature = messagesFeature({ h, wallet, ui, render, toast() {}, brandHeader: () => null,
  hook: k => k === 'nostrLoginIdentity' ? { pubkey: mine, signer } : null });
window.test = { ui, reply, other, root, render, waiting,
  seedFace: () => createThreadStore().save({ root, replies: [reply] }, reply.id, {
    [author]: { name: 'Nostrich', picture: 'https://example.com/nostrich.webp', eventAt: 10, t: Date.now(),
      thumbFor: 'https://example.com/nostrich.webp', thumb: 'data:image/png;base64,iVBORw0KGgo=', thumbPx: 144 },
  }),
  release: () => { for (const q of waiting.splice(0)) q.resolve(q.filter.ids ? [root] : []); },
  overlay: () => {
    ui.profilePk = author; ui.profOverThread = true; render();
    document.querySelector('#outside').replaceChildren(feature.actions(author, other, { canZap: false }));
  },
  missing: () => {
    const ev = { ...other, id: '1'.repeat(64), tags: [['e', '2'.repeat(64), '', 'root']] };
    document.querySelector('#outside').replaceChildren(feature.actions(author, ev, { canZap: false }));
  },
  empty: () => { for (const q of waiting.splice(0)) q.resolve([]); },
};
render();
`;
const bundle = await Bun.build({ entrypoints: ['thread-test-entry'], target: 'browser', plugins: [{ name: 'thread-test', setup(build) {
  build.onResolve({ filter: /^thread-test-entry$/ }, () => ({ path: 'entry', namespace: 'thread-test' }));
  build.onLoad({ filter: /.*/, namespace: 'thread-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace("id: 'messages',", "id: 'messages', row: noteRow, actions: noteActions,") }));
  build.onLoad({ filter: /src\/nostr\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {', 'export async function queryOn(relays, filter, maxWait = 1500) { return window.query(filter);')
    .replace('export async function publishOn(relays, evt) {', 'export async function publishOn(relays, evt) { window.sent.push(evt); return true;')
    .replace(/export function subscribeOn\(([^)]*)\) \{/, 'export function subscribeOn($1) { return () => {};') }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><div id="outside"></div><input id="elsewhere"><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
const check = (name, value) => { assert(value, name); console.log('✓ ' + name); };
const inline = () => page.evaluate(() => {
  const input = document.querySelector('.thread-reply-input');
  const box = input?.parentElement.parentElement;
  return !!input && box.previousElementSibling?.dataset.zapPost === test.ui.noteThread.focusId;
});
try {
  await page.goto(server.url.href);
  await page.waitForSelector('#app .note-act');
  await page.click('#app .note-act');
  check('Reply immediately shows its composer beneath the tapped post', await inline());
  check('the input receives focus before relay queries finish', await page.evaluate(() => document.activeElement.matches('.thread-reply-input')));
  await page.type('.thread-reply-input', 'A reply before the root loads');
  await page.click('.thread-reply-send');
  await page.waitForFunction(() => sent.length === 1);
  check('publishing targets the selected reply and its original root', await page.evaluate(() => sent[0].tags.some(t => t[0] === 'e' && t[1] === test.reply.id && t[3] === 'reply') && sent[0].tags.some(t => t[0] === 'e' && t[1] === test.root.id && t[3] === 'root')));
  await page.waitForFunction(() => test.waiting.length === 2);
  await page.evaluate(() => test.release());
  await page.waitForFunction(() => document.body.innerText.includes('Root post'));
  check('a relay result omitting the tapped reply keeps it and its composer', await inline());
  await page.evaluate(() => test.overlay());
  check('fixture starts with a profile covering the existing thread', await page.evaluate(() => test.ui.profOverThread && !document.querySelector('.thread-reply-input')));
  await page.click('#outside .note-act');
  check('Reply leaves the covering profile and inserts an uncached reply into the thread', await inline() && await page.evaluate(() => !test.ui.profOverThread && document.activeElement.matches('.thread-reply-input')));
  await page.evaluate(() => test.missing());
  await page.click('#outside .note-act');
  await page.waitForFunction(() => test.waiting.length === 2);
  await page.evaluate(() => test.empty());
  await page.waitForFunction(() => !document.querySelector('#app .spinner'));
  check('an unavailable root still leaves the selected post replyable', await inline());
  await page.evaluate(() => { test.ui.noteThread = null; test.ui.profilePk = null; test.render(); document.querySelector('#elsewhere').focus(); });
  await new Promise(r => setTimeout(r, 120));
  check('deferred focus does not steal focus after leaving the thread', await page.evaluate(() => document.activeElement.id === 'elsewhere'));
  await page.evaluate(() => test.seedFace());
  await page.reload();
  await page.waitForSelector('#app .note-act');
  await page.click('#app .note-act');
  check('cached thread author paints with name and local face on first frame', await page.evaluate(() => {
    const row = document.querySelector('.thread-page [data-zap-post]');
    return row?.textContent.includes('Nostrich') && row.querySelector('.note-avatar.ava-img')?.style.backgroundImage.includes('data:image/png;base64');
  }));
  assert.deepEqual(errors, []);
  console.log('✓ no browser errors');
} finally { await browser.close(); server.stop(true); }
