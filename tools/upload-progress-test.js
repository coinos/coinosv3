// uploadPublicMedia reports how much of the file has gone out (XMLHttpRequest
// upload events — fetch() can't), from 0 to 1, on a slow uplink.
//
// Run: bun tools/upload-progress-test.js
import puppeteer from 'puppeteer-core';
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const js = await Bun.build({ entrypoints: ['src/media-upload.js'], target: 'browser' }).then((b) => b.outputs[0].text());
let got = 0;
const server = Bun.serve({ port: 5289, async fetch(req) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, HEAD', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'x-reason' };
  const p = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (p === '/upload' && req.method === 'PUT') { got = (await req.arrayBuffer()).byteLength; return Response.json({ url: 'http://localhost:5289/' + 'a'.repeat(64) }, { status: 201, headers: cors }); }
  if (p === '/m.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
  return new Response('<script type=module>import * as m from "/m.js"; window.m = m;</script>', { headers: { 'content-type': 'text/html' } });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
try {
  await page.goto('http://localhost:5289/');
  await page.waitForFunction(() => !!window.m);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 5e6, uploadThroughput: 400e3 });
  const r = await page.evaluate(async () => {
    const seen = [];
    const file = new File([new Uint8Array(1_200_000)], 'v.mp4', { type: 'video/mp4' });
    const sign = async (e) => ({ ...e, id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128) });
    const url = await window.m.uploadPublicMedia(file, sign, { servers: ['http://localhost:5289'], onProgress: (p) => seen.push(Math.round(p * 100)) });
    return { url, seen };
  });
  check('the upload lands', r.url.startsWith('http://localhost:5289/') && got === 1_200_000, got + ' bytes');
  check('progress climbs from 0 to 100 as the bytes go', r.seen[0] === 0 && r.seen.at(-1) === 100 && r.seen.filter((p) => p > 0 && p < 100).length >= 3
    && r.seen.every((p, i) => !i || p >= r.seen[i - 1]), JSON.stringify(r.seen.slice(0, 15)) + (r.seen.length > 15 ? '…' : ''));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ uploads report their progress' : '\n❌ failed');
process.exit(ok ? 0 : 1);
