// A phone video is shrunk on the device before upload: 1080p at 20 Mbps in,
// H.264 720p around 2.5 Mbps out, moov first (streams while downloading),
// audio kept. Pasted into the reply box like a keyboard/gallery pick; the
// upload is caught and its bytes checked with ffprobe.
//
// Run: bun tools/video-compress-test.js
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const SRC = '/tmp/coinos-video-compress-src.mp4', OUT = '/tmp/coinos-video-compress-out.mp4';
// --portrait: the way phones record upright video — landscape frames plus a
// 90° rotation flag in the container
const PORTRAIT = process.argv.includes('--portrait');
Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '5', '-c:v', 'libx264', '-b:v', '20M', '-maxrate', '20M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);
if (PORTRAIT) {
  // (ffmpeg 4 writes the flag only on a remux)
  Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-i', SRC, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', SRC + '.rot.mp4']);
  Bun.spawnSync(['mv', SRC + '.rot.mp4', SRC]);
  const r = JSON.parse(new TextDecoder().decode(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', SRC]).stdout)).streams[0];
  console.log('   source rotation:', JSON.stringify(r.side_data_list || r.tags?.rotate || 'none'));
}
const srcSize = Bun.file(SRC).size;
// the split build: the compressor and Mediabunny are chunks loaded on demand
const built = Bun.spawnSync(['bun', 'run', 'build.js'], { stdout: 'pipe', stderr: 'pipe' });
if (built.exitCode) { console.log(new TextDecoder().decode(built.stderr)); process.exit(1); }
const dist = 'dist';
const server = Bun.serve({ port: 5287, fetch: async (req) => {
  const p = new URL(req.url).pathname;
  if (p === '/src.mp4') return new Response(Bun.file(SRC), { headers: { 'content-type': 'video/mp4' } });
  const f = Bun.file(dist + (p === '/' || !p.includes('.') ? '/index.html' : p));
  return (await f.exists()) ? new Response(f) : new Response(Bun.file(dist + '/index.html'));
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// the upload goes out by XMLHttpRequest (for its progress events): keep a
// copy of the body, and answer at the network layer — nothing leaves
await page.evaluateOnNewDocument(() => {
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__m = m; this.__url = String(url); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__m === 'PUT' && /nostr\.build|nostr\.download/.test(this.__url) && body instanceof Blob) {
      body.arrayBuffer().then((buf) => { window.__put = { size: body.size, type: body.type, buf }; });
    }
    return send.apply(this, arguments);
  };
  // every state the progress bar shows
  window.__prog = [];
  new MutationObserver(() => {
    const m = document.querySelector('.media-progress');
    const s = m ? m.innerText.replace(/\s+/g, ' ').trim() : null;
    if (s && window.__prog.at(-1) !== s) window.__prog.push(s);
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
});
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (!/nostr\.build|nostr\.download/.test(u)) return req.continue();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, HEAD, GET', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
  if (req.method() === 'HEAD') return req.respond({ status: 200, headers: cors });
  return req.respond({ status: 201, headers: cors, contentType: 'application/json',
    body: JSON.stringify({ url: 'https://blossom.nostr.build/' + 'f'.repeat(64) + '.mp4' }) });
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5287/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(600);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  await click('skip verification');
  await waitText('receive', 20000);
  check('the browser can encode H.264 (WebCodecs)', await page.evaluate(async () => (await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2.5e6 })).supported));
  // the post composer: the pencil on the feed
  await page.evaluate(() => document.querySelector('.app-bottom-nav .app-nav-button').click());
  await sleep(1500);
  await page.evaluate(() => document.querySelector('button[aria-label="New post"], button[title="New post"]')?.click());
  const box = await waitFor(() => !!document.querySelector('.post-input'), 8000);
  check('the post composer opens', box);
  const t0 = Date.now();
  await page.evaluate(async () => {
    const b = await (await fetch('/src.mp4')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([b], 'phone.mp4', { type: 'video/mp4' }));
    document.querySelector('.post-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const done = await waitFor(() => !!window.__put, 120000);
  await waitFor(() => !document.querySelector('.media-progress'), 10000);
  const prog = await page.evaluate(() => window.__prog);
  const pcts = (stage) => prog.filter((x) => x.startsWith(stage)).map((x) => +x.match(/(\d+)%/)[1]);
  const shrink = pcts('Shrinking video'), up = pcts('Uploading');
  check('a bar shows the shrinking with its percentage', shrink.length >= 3 && shrink.some((p) => p > 0 && p < 100), JSON.stringify(shrink.slice(0, 12)));
  // (the answer here is instant, so only its start shows — the percentages
  // themselves are upload-progress-test's)
  check('...then the upload with its own', up.length >= 1 && prog.findIndex((x) => x.startsWith('Uploading')) > prog.findIndex((x) => x.startsWith('Shrinking')), JSON.stringify(up));
  check('...and goes away when it is done', await page.evaluate(() => !document.querySelector('.media-progress')));
  const put = done && await page.evaluate(() => ({ size: window.__put.size, type: window.__put.type }));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check('the upload is the shrunk video', !!put && put.type === 'video/mp4' && put.size < srcSize * 0.35,
    put ? `${(srcSize / 1e6).toFixed(1)} MB → ${(put.size / 1e6).toFixed(1)} MB in ${secs}s` : 'no upload');
  if (put) {
    const b64 = await page.evaluate(() => { let s = ''; const u = new Uint8Array(window.__put.buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
    await Bun.write(OUT, Buffer.from(b64, 'base64'));
    const probe = JSON.parse(new TextDecoder().decode(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', OUT]).stdout));
    const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
    check('...H.264 at 720p', v?.codec_name === 'h264' && Math.min(v.width, v.height) === 720, `${v?.codec_name} ${v?.width}x${v?.height}`);
    if (PORTRAIT) {
      // upright on screen: either the frames are portrait, or they keep the rotation flag
      const rot = Math.abs(+((v.side_data_list || []).find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0));
      check('...still upright (portrait)', (v.height > v.width) !== (rot === 90 || rot === 270), `${v.width}x${v.height} rotation ${rot}`);
    }
    check('...around 2.5 Mbps', v && +v.bit_rate < 3.5e6, (+v?.bit_rate / 1e6).toFixed(2) + ' Mbps');
    check('...the whole clip, with its sound', Math.abs(+probe.format.duration - 5) < 0.3 && !!a, probe.format.duration + 's, audio ' + a?.codec_name);
    const head = new Uint8Array(await Bun.file(OUT).slice(0, 4096).arrayBuffer());
    const txt = new TextDecoder('latin1').decode(head);
    check('...moov before mdat, so it plays while downloading', txt.indexOf('moov') >= 0 && (txt.indexOf('mdat') < 0 || txt.indexOf('moov') < txt.indexOf('mdat')));
  }
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ videos are shrunk before upload' : '\n❌ failed');
process.exit(ok ? 0 : 1);
