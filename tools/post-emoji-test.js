// Exercise public reaction ingestion, rendering, signing and withdrawal.
// No requests or events leave this local fixture. Run: bun tools/post-emoji-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { messagesFeature } from './src/features/messages.js';
${dom}
const mine = 'a'.repeat(64), author = 'b'.repeat(64);
const note = { id: 'c'.repeat(64), pubkey: author, kind: 1, tags: [], content: 'A post' };
const ui = { screen: 'wallet' }, data = {};
window.sent = [];
let seq = 0, feature;
const signer = { signEvent: async e => ({ ...e, pubkey: mine, id: 'signed-' + ++seq }) };
const wallet = { loaded: true, loadFeatureState: (k, d) => data[k] || d, saveFeatureState: (k, v) => data[k] = v };
function render() {
  if (!feature) return;
  document.querySelector('#panel').replaceChildren(feature.panel(note));
  document.querySelector('#actions').replaceChildren(feature.actions(author, note, { canZap: false }));
}
feature = messagesFeature({ h, wallet, ui, render, toast() {}, brandHeader: () => null,
  hook: k => k === 'nostrLoginIdentity' ? { pubkey: mine, signer } : null });
window.test = {
  add: (content, code, url, pk = author) => {
    const ev = { id: 'received-' + ++seq, pubkey: pk, kind: 7, content,
      tags: [['e', note.id], ...(code ? [['emoji', code, url]] : [])] };
    feature.ingest(ev); render(); return ev;
  },
  duplicate: ev => { feature.ingest(ev); render(); },
  send: async emoji => { await feature.send(note, emoji); render(); },
  remove: async () => { await feature.remove(note); render(); },
  count: () => feature.count(note.id), mine,
};
`;
const bundle = await Bun.build({ entrypoints: ['post-emoji-entry'], target: 'browser', plugins: [{ name: 'post-emoji', setup(build) {
  build.onResolve({ filter: /^post-emoji-entry$/ }, () => ({ path: 'entry', namespace: 'post-emoji' }));
  build.onLoad({ filter: /.*/, namespace: 'post-emoji' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace("id: 'messages',", "id: 'messages', ingest: noteEvent, panel: whoPanel, actions: noteActions, send: reactTo, remove: unreact, count: whoCount,") }));
  build.onLoad({ filter: /src\/nostr\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {', 'export async function queryOn(relays, filter, maxWait = 1500) { return [];')
    .replace('export async function publishOn(relays, evt) {', 'export async function publishOn(relays, evt) { window.sent.push(evt); return true;') }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><style>${await Bun.file('src/style.css').text()}</style><div id="panel"></div><div id="actions"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname.endsWith('.gif')
  ? new Response(gif, { headers: { 'content-type': 'image/gif' } })
  : new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
const check = (name, value) => { assert(value, name); console.log('✓ ' + name); };
try {
  await page.goto(server.url.href);
  await page.waitForFunction(() => !!window.test);
  await page.evaluate(() => { window.first = test.add(':catJAM:', 'catJAM', location.origin + '/cat.gif'); });
  await page.waitForFunction(() => document.querySelector('#panel .cemoji')?.naturalWidth > 0);
  check('tagged catJAM renders a decodable image with its shortcode as alt text', await page.$eval('#panel .cemoji', e => e.alt === ':catJAM:' && e.src.endsWith('/cat.gif')));
  await page.evaluate(() => test.duplicate(first));
  check('duplicate events do not inflate the tally', await page.evaluate(() => test.count() === 1));
  await page.evaluate(() => test.add(':catJAM:', 'catJAM', location.origin + '/different.gif', 'd'.repeat(64)));
  check('identical shortcodes with different images stay separate', await page.evaluate(() => [...document.querySelectorAll('#panel .cemoji')].map(e => e.src).join('|') === location.origin + '/cat.gif|' + location.origin + '/different.gif'));
  await page.evaluate(() => test.add(':a_very_long_custom_emoji:', 'a_very_long_custom_emoji', location.origin + '/long.gif'));
  check('long shortcodes are preserved', await page.evaluate(() => !!document.querySelector('img[alt=":a_very_long_custom_emoji:"]')));
  await page.evaluate(() => { test.add(':missing:'); test.add(':unsafe:', 'unsafe', 'javascript:alert(1)'); test.add('+'); test.add('🔥'); });
  check('missing or unsafe tags fall back to text and standard reactions still render', await page.evaluate(() => [':missing:', ':unsafe:', '❤️', '🔥'].every(s => document.querySelector('#panel').innerText.includes(s)) && !document.querySelector('img[src^="javascript:"]')));
  await page.evaluate(() => test.send(':catJAM:'));
  check('outgoing custom reactions carry their image tag', await page.evaluate(() => sent.at(-1).tags.some(t => t[0] === 'emoji' && t[1] === 'catJAM' && t[2] === location.origin + '/different.gif')));
  check('our custom reaction renders on the action button', await page.evaluate(() => document.querySelector('#actions .cemoji')?.getAttribute('alt') === ':catJAM:'));
  await page.evaluate(() => test.remove());
  check('withdrawing it preserves other reactions and publishes deletion', await page.evaluate(() => !document.querySelector('#actions .cemoji') && sent.at(-1).kind === 5 && test.count() === 7));
  assert.deepEqual(errors, []);
  console.log('✓ no browser errors');
} finally { await browser.close(); server.stop(true); }
