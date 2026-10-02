// Real recipient portraits and profile fetches with controlled relay answers.
// Run: bun tools/send-avatar-loading-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const app = await Bun.file('src/app.js').text();
const domHelper = app.slice(app.indexOf('function h(tag,'), app.indexOf('// ---------------------------------------------------------------- morphing'));
const entry = `
import { messagesFeature } from './src/features/messages.js';
${domHelper}
const plans = new Map(), trace = [];
let feature, recipient;
const wallet = { nostr: { pk: 'f'.repeat(64) }, loadFeatureState: () => ({}), saveFeatureState() {}, registerCacheExtension() {} };
window.avatarLookup = async (filter) => {
  if (!filter.kinds.includes(0)) return [];
  return (await Promise.all((filter.authors || []).map(pk => plans.get(pk)?.answer || []))).flat();
};
function render() {
  if (!recipient) return;
  const portrait = feature.profileChip(recipient, 'lg');
  document.querySelector('#recipient').replaceChildren(portrait);
  trace.push({ punk: !!portrait.querySelector('.punk'), loading: !!portrait.querySelector('.loading') });
}
feature = messagesFeature({ h, wallet, ui: { screen: 'wallet' }, render, hook: () => false });
window.test = {
  start(pk, loadingName = false, expiredWait = false) {
    let finish;
    plans.set(pk, { answer: new Promise(resolve => finish = resolve), finish: result => finish(result) });
    if (loadingName) feature.testSeed(pk, { name: 'Recipient', t: 0, loading: true });
    if (expiredWait) feature.testExpiredWait(pk);
    recipient = pk; trace.length = 0; render();
  },
  complete(pk, profile) {
    plans.get(pk).finish(profile === null ? [] : [{ pubkey: pk, created_at: Math.floor(Date.now()/1000), content: JSON.stringify(profile) }]);
  },
  cached(pk, profile) { feature.testSeed(pk, { ...profile, t: Date.now() }); recipient = pk; render(); },
  get trace() { return trace; }, render,
  small(pk) { document.querySelector('#small').replaceChildren(feature.testAvatar(pk, 'chat-avatar mini', false)); },
};
`;
const bundle = await Bun.build({ entrypoints: ['avatar-test-entry'], target: 'browser', plugins: [{ name: 'avatar-test', setup(build) {
  build.onResolve({ filter: /^avatar-test-entry$/ }, () => ({ path: 'entry', namespace: 'avatar-test' }));
  build.onLoad({ filter: /.*/, namespace: 'avatar-test' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js',
    contents: (await Bun.file(path).text()).replace("id: 'messages',", `id: 'messages',
      testSeed: (pk, p) => profiles.set(pk, p),
      testExpiredWait: (pk) => faceAsked.set(pk, Date.now() - 10000), testAvatar: avatar,`),
  }));
  build.onLoad({ filter: /src\/nostr\.js$/ }, async ({ path }) => ({ loader: 'js',
    contents: (await Bun.file(path).text()).replace('export async function queryOn(relays, filter, maxWait = 1500) {',
      'export async function queryOn(relays, filter, maxWait = 1500) { return window.avatarLookup(filter);'),
  }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><style>${await Bun.file('src/style.css').text()}</style><div id="recipient"></div><div id="small"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (/^\/punks\/\d+\.webp$/.test(path)) return new Response(Bun.file('static' + path));
  return path === '/' ? new Response(html, { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 404 });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => r.url().startsWith(server.url.origin) ? r.continue() : r.abort());
  await page.goto(server.url.href);
  await page.waitForFunction(() => window.test);
  const state = () => page.$eval('.send-avatar', e => ({ loading: e.classList.contains('loading'), punk: !!e.querySelector('.punk'), picture: e.style.backgroundImage, hidden: getComputedStyle(e).visibility === 'hidden' }));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const [i, loadingName, expiredWait] of [[1, false, false], [2, true, false], [3, true, true]]) {
    const pk = String(i).repeat(64);
    await page.evaluate(([pk, name, expired]) => test.start(pk, name, expired), [pk, loadingName, expiredWait]);
    assert.deepEqual(await state(), { loading: true, punk: false, picture: '', hidden: true }, 'cold lookup paints no visible placeholder');
    await pause(1350);
    await page.evaluate(() => test.render());
    assert.deepEqual(await state(), { loading: true, punk: false, picture: '', hidden: true }, 'slow metadata lookup never times out into punk art');
    await page.evaluate(pk => test.complete(pk, { name: 'Recipient', picture: '/punks/18.webp' }), pk);
    await page.waitForSelector('.send-avatar.ava-img');
    assert((await state()).picture.includes('/punks/18.webp'));
    assert(await page.evaluate(() => test.trace.every(frame => !frame.punk)), 'no fallback punk appeared before the real picture');
  }
  console.log('✓ Cold, name-only and previously timed-out recipients show no placeholder before their picture arrives');

  await page.evaluate(() => test.cached('4'.repeat(64), { name: 'Cached', picture: '/punks/54.webp' }));
  assert((await state()).picture.includes('/punks/54.webp'));
  assert.equal((await state()).loading, false);
  console.log('✓ Cached recipient pictures appear immediately');

  for (const [i, loadingName, result] of [[5, false, { name: 'No picture' }], [6, false, null], [7, true, null]]) {
    const pk = String(i).repeat(64);
    await page.evaluate(([pk, name]) => test.start(pk, name), [pk, loadingName]);
    await page.evaluate(([pk, result]) => test.complete(pk, result), [pk, result]);
    await page.waitForSelector('.send-avatar .punk');
    assert.equal((await state()).loading, false, 'finished or missing profile uses its actual fallback');
  }
  console.log('✓ Profiles without pictures and failed lookups settle into their fallback avatar');

  await page.evaluate(() => test.small('8'.repeat(64)));
  assert(await page.$('#small .punk'), 'compact avatars retain their immediate fallback');
  assert.deepEqual(errors, []);
  console.log('✓ Compact avatars keep existing behavior; no browser errors');
} finally { await browser.close(); server.stop(true); }
