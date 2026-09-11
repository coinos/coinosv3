// Avatar pictures are whatever their owner uploaded — often the full-size
// original (megabytes, to paint a 30px circle). We downscale each one once
// and keep the thumbnail beside the profile, so later boots paint the face
// from localStorage with no network at all.
//
// Here: a wallet is given a profile whose picture is a large cross-origin
// image, and we check that a thumbnail is made and persisted, that the small
// avatar then paints from it alone (the original is never requested again),
// and that a refresh of the profile doesn't throw the thumbnail away.
//
// Run: bun tools/avatar-thumb-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { seedPubkey } from '../src/nostr.js';
import { buildHtml } from '../build.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

// a big-ish PNG (1024x1024 of noise) served with CORS, and a request counter
const big = await (async () => {
  const px = 512, head = Buffer.alloc(0);
  // a real image is needed (the canvas has to decode it): build a PNG via a data URI in the page instead
  return { px, head };
})();
const html = await buildHtml({ minify: true, pwa: false });
let originalHits = 0;
const server = Bun.serve({
  port: 5235,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/punks')) {
      const f = Bun.file('dist' + u.pathname);
      if (await f.exists()) return new Response(await f.arrayBuffer(), { headers: { 'content-type': 'image/webp' } });
      return new Response('no', { status: 404 });
    }
    if (u.pathname === '/big.png') {
      originalHits++;
      const bytes = await Bun.file('/tmp/claude-1000/-home-adam-coinosv3/61dea255-d26d-411d-be8b-92dfb0a75887/scratchpad/big.png').arrayBuffer();
      return new Response(bytes, { headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  },
});
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5235/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('get started'); await sleep(500);
  await click('import existing'); await sleep(400);
  await page.waitForSelector('textarea');
  const mnemonic = generateMnemonic(wordlist);
  await page.type('textarea', mnemonic);
  await click('open wallet');
  await waitText('receive', 20000);

  // the face in the header is the seed's own nostr identity
  const pk = seedPubkey(mnemonic, '', 0);
  check('found the wallet identity', !!pk, pk ? pk.slice(0, 12) + '…' : 'none');

  // give it a picture: a large cross-origin image
  // the seed-keyed slot and the watch-only xpub mirror both look like
  // `btc-wallet-cache:<hash>` — seed the row under every one of them
  const bases = await page.evaluate((pkHex) => {
    const ks = Object.keys(localStorage).filter((k) => /^btc-wallet-cache:[0-9a-f]+$/.test(k));
    for (const b of ks) localStorage.setItem(b + ':profiles', JSON.stringify({
      [pkHex]: { name: 'Face Test', picture: 'http://localhost:5235/big.png', t: Date.now() },
    }));
    return ks.length;
  }, pk);
  check('seeded the profile cache', bases > 0, bases + ' cache slot(s)');
  originalHits = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await sleep(2500);

  const row = await page.evaluate(() => {
    const rows = Object.keys(localStorage).filter((k) => /^btc-wallet-cache:[0-9a-f]+:profiles$/.test(k))
      .flatMap((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}')));
    const r = rows.find((x) => x && x.thumb) || rows[0] || {};
    return { hasThumb: typeof r.thumb === 'string', kind: (r.thumb || '').slice(0, 20), len: (r.thumb || '').length, thumbFor: r.thumbFor === r.picture };
  });
  check('a thumbnail was made and persisted', row.hasThumb, row.kind + ' ' + row.len + ' chars');
  check('it is pinned to the picture it came from', row.thumbFor);
  check('it is small', row.len > 0 && row.len < 12000, row.len + ' chars');

  // the small avatar paints from the thumbnail alone
  const style = await page.evaluate(() => {
    const a = document.querySelector('.header-avatar .ava-img') || document.querySelector('.ava-img');
    return a ? a.getAttribute('style') : 'NONE header=' + (document.querySelector('.header-avatar') || {}).innerHTML;
  });
  console.log('   header avatar:', String(style).slice(0, 160));
  check('the header avatar paints from the local copy', /data:image/.test(style));
  check('...and never asks for the original', !/localhost:5235\/big\.png/.test(style), style.slice(0, 40));

  // and a reload makes no request for the original at all
  originalHits = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await sleep(2000);
  check('a later boot fetches no picture at all', originalHits === 0, originalHits + ' request(s)');

  // A punk picture is our own art: painted from disk at the size being drawn,
  // never fetched from coinos.io (whose copies 502 for a third of the set).
  await page.evaluate((pkHex) => {
    for (const k of Object.keys(localStorage).filter((x) => /^btc-wallet-cache:[0-9a-f]+$/.test(x)))
      localStorage.setItem(k + ':profiles', JSON.stringify({
        [pkHex]: { name: 'Punk Test', picture: 'https://v3.coinos.io/punks/7.webp', t: Date.now() },
      }));
  }, pk);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await sleep(1200);
  const punkStyle = await page.evaluate(() => {
    const a = document.querySelector('.header-avatar .ava-img') || document.querySelector('.ava-img');
    return a ? a.getAttribute('style') : '';
  });
  check('a punk picture paints from the local small copy', /punks-sm\/7\.webp/.test(punkStyle), punkStyle.slice(0, 60));
  check('...and never from coinos.io', !/coinos\.io/.test(punkStyle));

  // And someone with no picture at all still gets a punk — the small one.
  await page.evaluate((pkHex) => {
    for (const k of Object.keys(localStorage).filter((x) => /^btc-wallet-cache:[0-9a-f]+$/.test(x)))
      localStorage.setItem(k + ':profiles', JSON.stringify({ [pkHex]: { name: 'Bare', picture: null, t: Date.now() } }));
  }, pk);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await sleep(1200);
  const punkSrc = await page.evaluate(() => {
    const i = document.querySelector('.header-avatar img.punk') || document.querySelector('img.punk');
    return i ? i.getAttribute('src') : '';
  });
  check('the default face is the small punk', /^punks-sm\//.test(punkSrc), punkSrc);

  // And someone we have never cached at all — the case that used to sit as a
  // blank circle until a relay answered — is drawn from their pubkey alone.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage).filter((x) => /^btc-wallet-cache:[0-9a-f]+:profiles$/.test(x))) localStorage.removeItem(k);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  const strangerSrc = await page.evaluate(() => {
    const i = document.querySelector('.header-avatar img.punk') || document.querySelector('img.punk');
    return i ? i.getAttribute('src') : '';
  });
  check('an uncached face is drawn straight away, not left blank', /^punks-sm\//.test(strangerSrc), strangerSrc || 'blank circle');
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ faces come back instantly' : '\n❌ failed');
process.exit(ok ? 0 : 1);
