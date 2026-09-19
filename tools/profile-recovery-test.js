// Profile misses must preserve cached details, fall back to index relays,
// and remain retryable. Tests real rendering with deterministic relay replies.
// Run: bun tools/profile-recovery-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { messagesFeature } from './src/features/messages.js';
import { fallbackAvatar, punkUrl, punkSmallUrl } from './src/recipient-search.js';
${dom}
const pk = 'a'.repeat(64), other = 'b'.repeat(64);
const cached = { name: 'Cached person', picture: 'https://example.invalid/photo.jpg', about: 'Cached bio' };
const data = { profiles: { [pk]: { ...cached, t: Date.now(), eventAt: 1 } }, profPages: { full: { [pk]: { t: Date.now(), v: cached } } } };
const ui = { screen: 'wallet', profilePk: pk };
let feature, mode = 'empty', release;
const asks = [];
const event = (author, name, created_at = 2) => ({ pubkey: author, kind: 0, created_at, content: JSON.stringify({ name, about: name + ' bio', picture: '' }), tags: [] });
window.__profileQuery = async (relays, filter) => {
  asks.push({ relays, kinds: filter.kinds });
  if (filter.kinds[0] !== 0) return [];
  if (mode === 'hold') return new Promise(r => { release = r; });
  if (mode === 'index' && relays.includes('wss://purplepag.es')) return [event(filter.authors[0], 'Recovered person')];
  return [];
};
const wallet = { mnemonic: 'test', loadFeatureState: (key, fallback) => data[key] || fallback,
  saveFeatureState: (key, value) => data[key] = value, nostr: null };
function render() {
  if (feature) document.querySelector('#profile').replaceChildren(feature.testView(pk));
}
feature = messagesFeature({ h, ui, wallet, render, hook: () => null, brandHeader: () => null, toast() {} });
window.test = {
  pk, other, asks, data, feature, event, render,
  fetch: (author = pk) => feature.testFetch(author),
  show: author => { ui.profilePk = author; render(); },
  mode: value => mode = value,
  release: () => { mode = 'empty'; release([]); },
  avatar: () => { document.querySelector('#avatar').replaceChildren(fallbackAvatar(h, pk, 'Person', 'chat-avatar profile-avatar')); },
  urls: () => [punkUrl(pk), punkSmallUrl(pk)],
};
render();
`;
const bundle = await Bun.build({ entrypoints: ['profile-test-entry'], target: 'browser', plugins: [{ name: 'profile-test', setup(build) {
  build.onResolve({ filter: /^profile-test-entry$/ }, () => ({ path: 'entry', namespace: 'profile-test' }));
  build.onLoad({ filter: /.*/, namespace: 'profile-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ contents: (await Bun.file(path).text())
    .replace("id: 'messages',", "id: 'messages', testFetch: fetchFullProfile, testView: profileScreen, testApply: applyProfile, testLight: (pk) => profiles.get(pk), testFull: (pk) => fullProfiles.get(pk),"), loader: 'js' }));
  build.onLoad({ filter: /src\/nostr\.js$/ }, async ({ path }) => ({ contents: (await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {', 'export async function queryOn(relays, filter, maxWait = 1500) { if (globalThis.__profileQuery) return globalThis.__profileQuery(relays, filter);'), loader: 'js' }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const css = await Bun.file('src/style.css').text();
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="profile"></div><div id="avatar"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname.startsWith('/punks')
  ? new Response('missing', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
const check = (name, value) => { assert(value, name); console.log(' ✓ ' + name); };
try {
  await page.goto(server.url.href + 'someone/');
  await page.waitForFunction(() => !!window.test);
  await page.evaluate(() => test.fetch());
  check('an empty fetch preserves cached name, photo and bio', await page.evaluate(() => test.feature.testLight(test.pk).name === 'Cached person' && test.feature.testFull(test.pk).about === 'Cached bio' && test.data.profiles[test.pk].picture === 'https://example.invalid/photo.jpg'));
  check('a miss offers Retry instead of becoming permanent', await page.evaluate(() => document.body.innerText.includes('Couldn’t load the latest profile.') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Retry')));
  await page.evaluate(() => { test.mode('index'); [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry').click(); });
  await page.waitForFunction(() => document.body.innerText.includes('Recovered person bio'));
  check('retry recovers a profile from an index relay', await page.evaluate(() => test.feature.testLight(test.pk).name === 'Recovered person' && !document.body.innerText.includes('Couldn’t load the latest profile.')));
  await page.evaluate(() => { test.mode('hold'); window.pending = test.fetch(test.other); test.feature.testApply(test.other, test.event(test.other, 'Arrived in batch', 10)); test.release(); });
  await page.evaluate(() => window.pending);
  check('a slow empty page fetch cannot erase a successful batch answer', await page.evaluate(() => test.feature.testLight(test.other).name === 'Arrived in batch' && test.feature.testFull(test.other).name === 'Arrived in batch'));
  await page.evaluate(() => test.feature.testApply(test.other, test.event(test.other, 'Old answer', 5)));
  check('an older relay response cannot overwrite newer metadata', await page.evaluate(() => test.feature.testLight(test.other).name === 'Arrived in batch'));
  await page.evaluate(async () => { const missing = 'c'.repeat(64); test.mode('empty'); test.show(missing); await test.fetch(missing); });
  check('a key without cached or published details shows a neutral missing-profile message and Retry', await page.evaluate(() => document.body.innerText.includes('No profile details found on the available relays.') && !document.body.innerText.includes('Couldn’t load the latest profile.') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Retry')));
  check('avatar paths are rooted even on a trailing-slash profile URL', await page.evaluate(() => test.urls().every(url => url.startsWith('/punks'))));
  await page.evaluate(() => test.avatar());
  await page.waitForFunction(() => !document.querySelector('#avatar img'));
  await page.evaluate(() => test.avatar());
  check('failed fallback images stay removed across redraws', await page.evaluate(() => !document.querySelector('#avatar img') && document.querySelector('#avatar').textContent === 'Pe'));
  assert.deepEqual(errors, []);
  console.log(' ✓ no browser errors');
} finally { await browser.close(); server.stop(true); }
