// A tall picture in a feed post is fitted inside its box, leaving blank
// bands either side. A tap on a band opens the post (its thread); a tap on
// the picture opens the picture.
//
// Run: bun tools/image-tap-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const png = '/tmp/coinos-image-tap-test.png';
Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=800x1600', '-frames:v', '1', png]);
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5281, fetch: (req) => new URL(req.url).pathname === '/tall.png'
  ? new Response(Bun.file(png), { headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' } })
  : new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5281/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('create a new wallet'); await sleep(600);
  await page.waitForSelector('.words .w .t');
  const mn = (await page.$$eval('.words .w .t', (l) => l.map((e) => e.textContent.trim()))).join(' ');
  await click('skip verification');
  await waitText('receive', 20000);
  const base = cacheKeyFor(mn + '\n');
  const A = 'a'.repeat(63) + '9';
  await page.evaluate(([k, a]) => {
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(k + ':follows', JSON.stringify({ tags: [['p', a]], c: '', at: now }));
    localStorage.setItem(k + ':feedNotes', JSON.stringify([{ id: 'c'.repeat(64), pubkey: a, kind: 1, created_at: now, content: 'a tall one http://localhost:5281/tall.png', tags: [] }]));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [a]: { name: 'Poster', t: Date.now() } }));
  }, [base, A]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => document.querySelector('.app-bottom-nav .app-nav-button').click());
  check('the picture is in the post', await waitFor(() => { const i = document.querySelector('.notes-feed img.note-img'); return i && i.complete && i.naturalWidth > 0; }, 20000));
  // on the phone the box spans the column and the picture sits in its middle
  // (object-fit: contain); desktop Chrome sizes the box to the picture, so
  // widen it the way the phone lays it out
  const widen = () => page.evaluate(() => { const i = document.querySelector('.notes-feed img.note-img'); i.style.width = '100%'; i.style.height = '320px'; });
  await widen();
  const r = await page.evaluate(() => { const b = document.querySelector('.notes-feed img.note-img').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  const drawn = r.h * 800 / 1600; // the picture's drawn width inside the box
  check('the box is wider than the picture (blank bands)', r.w > drawn + 40, JSON.stringify({ box: Math.round(r.w), drawn: Math.round(drawn) }));

  const beside = process.env.DBG && await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const chain = []; for (let n = e; n && chain.length < 5; n = n.parentElement) chain.push(n.tagName + '.' + (n.className || '').toString().split(' ').join('.') + (n.onclick ? '[click]' : '')); return chain; }, [r.x + 8, r.y + r.h / 2]);
  await page.mouse.click(r.x + 8, r.y + r.h / 2);
  await sleep(1200);
  const band = await page.evaluate(() => ({ thread: !!document.querySelector('.thread-page'), lightbox: !!document.querySelector('.lightbox') }));
  check('a tap on the blank band opens the post', band.thread && !band.lightbox, JSON.stringify(band));
  await page.goBack(); await sleep(1200);

  await widen();
  const r2 = await page.evaluate(() => { const b = document.querySelector('.notes-feed img.note-img').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  await page.mouse.click(r2.x + r2.w / 2, r2.y + r2.h / 2);
  await sleep(800);
  const pic = await page.evaluate(() => ({ thread: !!document.querySelector('.thread-page'), lightbox: !!document.querySelector('.lightbox') }));
  check('a tap on the picture opens the picture', pic.lightbox && !pic.thread, JSON.stringify(pic));
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ bands open the post, the picture opens the picture' : '\n❌ failed');
process.exit(ok ? 0 : 1);
