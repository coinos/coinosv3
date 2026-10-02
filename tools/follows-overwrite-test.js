// A follow list must never be written over one we failed to find.
//
// 2026-10-02: a long-time nostr user (398 follows, kept on her own relays
// and an archive) signed in to coinos for the first time; the starter-follows
// seed asked only our relays, found nothing, and published a two-person list
// that replaced hers everywhere. These scenarios run the messages feature
// against an in-page relay network where only an archive relay holds the
// real list, and record every event the wallet publishes.
// Run: bun tools/follows-overwrite-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';

const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf("const root = document.getElementById('app');"));
const entry = `
import { messagesFeature } from './src/features/messages.js';
import { hexToBytes } from '@noble/hashes/utils';
${dom}
window.makeFeature = (skHex) => {
  const store = {};
  const ui = { screen: 'wallet' };
  const wallet = { xpub: 'w-' + skHex.slice(0, 6), loaded: true, nostrRelays: () => [],
    nostr: { sk: hexToBytes(skHex), pk: window.pkOf(skHex) },
    loadFeatureState: (k, d) => (k in store ? store[k] : d), saveFeatureState: (k, v) => { store[k] = v; },
    registerCacheExtension() {}, _cacheKey: () => 'k' };
  const feature = messagesFeature({ h, ui, wallet, render() {}, toast: (m) => window.toasts.push(m), hook: () => null,
    brandHeader: () => h('div', {}, '') });
  return feature;
};
`;
const bundle = await Bun.build({ entrypoints: ['ow-entry'], target: 'browser', plugins: [{ name: 'ow', setup(build) {
  build.onResolve({ filter: /^ow-entry$/ }, () => ({ path: 'entry', namespace: 'ow' }));
  build.onLoad({ filter: /.*/, namespace: 'ow' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text()).replace("id: 'messages',",
    "id: 'messages', testFollow: (pk) => toggleFollow(pk), testHistory: () => findFollowHistory(), testRestore: (e) => restoreFollows(e), testFollowing: () => [...followsNow().set],") }));
} }] });
const js = await bundle.outputs[0].text();

// The relay network, in the page: per-URL stores, REQ answered from them,
// every EVENT recorded (and stored, like a relay would).
const fakeNet = `
window.toasts = [];
window.published = [];
window.relayStore = {};
const match = (f, e) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f.ids || f.ids.includes(e.id));
class FakeWS {
  constructor(url) {
    this.url = String(url).replace(/\\/$/, ''); this.readyState = 0;
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 5);
  }
  send(raw) {
    const m = JSON.parse(raw);
    const reply = (x) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(x) }), 5);
    if (m[0] === 'REQ') {
      if (m[2] && m[2].cache) { reply(['EOSE', m[1]]); return; } // Primal's cache: knows nothing here
      const evs = (window.relayStore[this.url] || []);
      for (const f of m.slice(2)) for (const e of evs) if (match(f, e)) reply(['EVENT', m[1], e]);
      reply(['EOSE', m[1]]);
    } else if (m[0] === 'EVENT') {
      window.published.push({ url: this.url, ev: m[1] });
      (window.relayStore[this.url] ||= []).push(m[1]);
      reply(['OK', m[1].id, true, '']);
    }
  }
  close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000 }); }
  addEventListener(t, fn) { this['on' + t] = fn; }
  removeEventListener() {}
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
window.WebSocket = FakeWS;
`;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script>${fakeNet}</script><script type="module">${js}</script></body></html>`;
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => { const sk = generateSecretKey(); return { sk, hex: bytesToHex(sk), pk: getPublicKey(sk) }; };
const someone = () => getPublicKey(generateSecretKey());
const contactList = (k, pks, created_at, client) => finalizeEvent({ kind: 3, created_at, content: '', tags: [...pks.map((p) => ['p', p]), ...(client ? [['client', client]] : [])] }, k.sk);
const STARTERS = ['98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7', '72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb'];

async function freshPage(store) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERR', e.message.slice(0, 300)); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
  await page.goto(server.url.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.makeFeature, { timeout: 10000 });
  await page.evaluate((s) => { window.relayStore = s; }, store);
  return { page, errors };
}
const kind3s = (page) => page.evaluate(() => window.published.filter((p) => p.ev.kind === 3).map((p) => ({ url: p.url, tags: p.ev.tags })));

try {
  // 1. An existing nostr user, list only on an archive relay → no starter seed.
  {
    const annie = key();
    const real = [someone(), someone(), someone()];
    const { page, errors } = await freshPage({ 'wss://nostr21.com': [contactList(annie, real, 1780000000, 'Amethyst')] });
    await page.evaluate((h) => { window.pkOf = () => null; }, annie.hex);
    await page.evaluate((h, pk) => { window.pkOf = () => pk; window.f = window.makeFeature(h); window.f.identitySignedInNew(); }, annie.hex, annie.pk);
    await sleep(12000);
    const pubs = await kind3s(page);
    assert.equal(pubs.length, 0, 'a key with a follow list anywhere gets no starter list: ' + JSON.stringify(pubs).slice(0, 200));
    console.log('✓ signing in with a list kept only on an archive relay publishes no starter follows');

    // ...and following someone builds on the archived list, not on nothing
    const extra = someone();
    await page.evaluate((pk) => window.f.testFollow(pk), extra);
    await sleep(500);
    const after = await kind3s(page);
    assert(after.length > 0, 'the follow was published');
    const pks = new Set(after[0].tags.filter((t) => t[0] === 'p').map((t) => t[1]));
    for (const p of real) assert(pks.has(p), 'the archived follows are kept: missing ' + p.slice(0, 8));
    assert(pks.has(extra) && pks.size === 4, 'plus the new one: ' + pks.size);
    assert.deepEqual(errors, []);
    console.log('✓ a follow made before the list was ever seen is added to the archived list (4 = 3 + 1)');
    await page.close();
  }

  // 2. A key with a profile but no follow list → still no starter list.
  {
    const k = key();
    const prof = finalizeEvent({ kind: 0, created_at: 1780000000, content: JSON.stringify({ name: 'old hand' }), tags: [] }, k.sk);
    const { page } = await freshPage({ 'wss://purplepag.es': [prof] });
    await page.evaluate((h, pk) => { window.pkOf = () => pk; window.f = window.makeFeature(h); window.f.identitySignedInNew(); }, k.hex, k.pk);
    await sleep(12000);
    assert.equal((await kind3s(page)).length, 0, 'a key with a profile anywhere gets no starter list');
    console.log('✓ a key with a profile but no follow list gets no starter follows either');
    await page.close();
  }

  // 3. A key with no trace anywhere → the starter follows, as before.
  {
    const k = key();
    const { page } = await freshPage({});
    await page.evaluate((h, pk) => { window.pkOf = () => pk; window.f = window.makeFeature(h); window.f.identitySignedInNew(); }, k.hex, k.pk);
    await sleep(12000);
    const pubs = await kind3s(page);
    assert(pubs.length > 0, 'a brand-new key gets its starter list');
    assert.deepEqual(pubs[0].tags.filter((t) => t[0] === 'p').map((t) => t[1]).sort(), [...STARTERS].sort());
    console.log('✓ a brand-new key still gets the starter follows');
    await page.close();
  }

  // 4. Restore: the current list is the two-person replacement, an older copy
  //    survives on an archive → restoring puts everyone back, nobody removed.
  {
    const k = key();
    const real = Array.from({ length: 5 }, someone);
    const kept = someone();
    const { page, errors } = await freshPage({
      'wss://nostr21.com': [contactList(k, real, 1780000000, 'Amethyst')],
      'wss://relay.damus.io': [contactList(k, [...STARTERS, kept], 1790000000)],
    });
    await page.evaluate((h, pk) => { window.pkOf = () => pk; window.f = window.makeFeature(h); }, k.hex, k.pk);
    const versions = await page.evaluate(async () => (await window.f.testHistory()).map((e) => ({ n: e.tags.filter((t) => t[0] === 'p').length, e })));
    assert.equal(versions.length, 2, 'both copies found: ' + versions.map((v) => v.n));
    const old = versions.find((v) => v.n === 5).e;
    await page.evaluate((e) => window.f.testRestore(e), old);
    await sleep(500);
    const pubs = await kind3s(page);
    const pks = new Set(pubs[pubs.length - 1].tags.filter((t) => t[0] === 'p').map((t) => t[1]));
    for (const p of [...real, ...STARTERS, kept]) assert(pks.has(p), 'restored list keeps ' + p.slice(0, 8));
    assert.equal(pks.size, 8);
    assert(await page.evaluate(() => window.toasts.some((t) => /Restored 5/.test(t))), 'says how many came back');
    assert.deepEqual(errors, []);
    console.log('✓ restoring an archived copy merges it into the current list (5 back, 3 kept)');
    await page.close();
  }
  console.log('\n✅ follow lists are never written over unseen');
} finally {
  await browser.close();
  server.stop(true);
}
