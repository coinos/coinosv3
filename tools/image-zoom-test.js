// The full-screen picture: pinch to zoom, pan when zoomed, double-tap to zoom
// and reset, a background render keeps the zoom, taps after a gesture don't
// close it, a plain tap still does, and the wheel zooms on a desktop.
// Run: bun tools/image-zoom-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf("const root = document.getElementById('app');"));
const viewer = app.slice(app.indexOf('function imageViewer()'), app.indexOf("if (typeof window !== 'undefined') {\n  window.addEventListener('keydown'"));
const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#48a"/><circle cx="400" cy="300" r="120" fill="#fc3"/></svg>');
const entry = `
${dom}
${viewer}
const ui = { lightbox: 'data:image/svg+xml,${svg}' };
const t = (k) => k;
const goBack = (fn) => { fn(); render(); };
function render() { morphChildren(document.querySelector('#app'), ui.lightbox ? [imageViewer()] : []); }
window.test = { ui, render, open() { ui.lightbox = 'data:image/svg+xml,${svg}'; render(); } };
render();
`;
const bundle = await Bun.build({ entrypoints: ['zoom-entry'], target: 'browser', plugins: [{ name: 'zoom', setup(build) {
  build.onResolve({ filter: /^zoom-entry$/ }, () => ({ path: 'entry', namespace: 'zoom' }));
  build.onLoad({ filter: /.*/, namespace: 'zoom' }, () => ({ contents: entry, loader: 'js', resolveDir: process.cwd() }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zoom = () => page.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.lightbox img')).transform); return { s: +m.a.toFixed(2), x: Math.round(m.e), y: Math.round(m.f) }; });
const open = () => page.evaluate(() => !!test.ui.lightbox && !!document.querySelector('.lightbox'));
try {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(server.url.href);
  await page.waitForSelector('.lightbox img');
  const cdp = await page.target().createCDPSession();
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const cx = 195, cy = 422;
  // pinch out around the centre
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]); await sleep(16); }
  await touch('touchEnd', []); await sleep(350);
  let z = await zoom();
  assert(z.s > 3.8 && z.s < 4.2, 'pinch zooms with the fingers (80px → 320px apart = 4×): ' + JSON.stringify(z));
  assert(await open(), 'a pinch does not close the picture');
  // a background render keeps the zoom
  await page.evaluate(() => test.render()); await sleep(50);
  assert.equal((await zoom()).s, z.s, 'a background render keeps the zoom');
  // one finger pans the zoomed picture, clamped to its edges
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[cx + i * 20, cy + i * 5]]); await sleep(16); }
  await touch('touchEnd', []); await sleep(350);
  const panned = await zoom();
  assert(panned.x > z.x + 50, 'drag pans: ' + JSON.stringify(panned));
  const maxX = await page.evaluate((s) => (document.querySelector('.lightbox img').offsetWidth * s - innerWidth) / 2, panned.s);
  assert(panned.x <= maxX + 1, 'pan is held to the picture edge');
  assert(await open(), 'a drag does not close the picture');
  // a tap while zoomed does not close; a double-tap resets
  await page.touchscreen.tap(cx, cy); await sleep(400);
  assert(await open(), 'a tap while zoomed does not close');
  await page.touchscreen.tap(cx, cy); await sleep(80); await page.touchscreen.tap(cx, cy); await sleep(350);
  assert.equal((await zoom()).s, 1, 'double-tap resets the zoom');
  // double-tap at 1× zooms in at the spot, without closing
  await page.touchscreen.tap(cx + 60, cy); await sleep(80); await page.touchscreen.tap(cx + 60, cy); await sleep(400);
  z = await zoom();
  assert(z.s === 2.5 && z.x < 0, 'double-tap zooms in toward the tapped spot: ' + JSON.stringify(z));
  assert(await open(), 'a double-tap does not close');
  await page.touchscreen.tap(cx, cy); await sleep(80); await page.touchscreen.tap(cx, cy); await sleep(350);
  // a single tap at 1× still closes
  await page.touchscreen.tap(cx, cy); await sleep(450);
  assert(!(await open()), 'a single tap closes the picture');
  // desktop: the wheel zooms toward the cursor
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluate(() => test.open()); await page.waitForSelector('.lightbox img');
  await page.mouse.move(700, 400);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(30); }
  z = await zoom();
  assert(z.s > 1.5, 'the wheel zooms in: ' + JSON.stringify(z));
  assert(await open(), 'wheel zoom leaves the picture open');
  assert.deepEqual(errors, []);
  console.log('✓ Image viewer: pinch zooms, drag pans within the edges, double-tap zooms and resets, renders keep the zoom, gestures never close it, a tap does, the wheel zooms on desktop');
} finally { await browser.close(); server.stop(true); }
