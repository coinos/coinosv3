// Pinch and pan keep the viewer open; taps dismiss at any zoom immediately,
// even before navigation finishes. Background renders preserve zoom and
// dismissal; the close button bypasses gesture suppression.
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
let backCalls = 0, backDelay = 0, backSawViewer = null;
const goBack = (fn) => {
  backCalls++; backSawViewer = !!document.querySelector('.lightbox');
  if (backDelay) setTimeout(() => { fn(); render(); }, backDelay);
  else { fn(); render(); }
};
function render() { morphChildren(document.querySelector('#app'), ui.lightbox ? [imageViewer()] : []); }
window.test = { ui, render, get backCalls() { return backCalls; }, get backSawViewer() { return backSawViewer; },
  delayBack(ms) { backDelay = ms; },
  open() { ui.lightbox = 'data:image/svg+xml,${svg}'; document.documentElement.classList.add('no-scroll'); render(); } };
document.addEventListener('click', () => { window.closedDuringClick = !document.querySelector('.lightbox'); });
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
const assertDismissed = async (label) => {
  assert(!(await open()), label);
  assert(await page.evaluate(() => closedDuringClick && test.backSawViewer === false
    && !document.documentElement.classList.contains('no-scroll')), 'viewer disappears during the click, before navigation, and unlocks page scrolling');
};
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
  await page.evaluate(() => test.render());
  await page.touchscreen.tap(cx, cy);
  await assertDismissed('a tap closes the zoomed, panned picture immediately after a background render');

  // No 300ms double-tap wait, nor a wait for history and page rendering.
  await page.evaluate(() => { test.open(); test.delayBack(200); });
  await page.waitForFunction(() => document.querySelector('.lightbox img')?.complete);
  await page.touchscreen.tap(cx, cy);
  await assertDismissed('a tap at 1× immediately closes even with slow navigation');
  await sleep(250);
  await page.evaluate(() => test.delayBack(0));

  await page.evaluate(() => test.open());
  await page.touchscreen.tap(10, 50);
  await assertDismissed('a tap on the backdrop closes immediately');

  // Two fingers without motion and a cancelled gesture aren't dismissals.
  await page.evaluate(() => test.open());
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  await touch('touchEnd', []);
  assert(await open(), 'a two-finger touch never closes the picture');
  await touch('touchStart', [[cx, cy]]);
  await touch('touchCancel', []);
  await page.evaluate(() => document.querySelector('.lightbox img').click());
  assert(await open(), 'a cancelled gesture suppresses its click');
  await page.touchscreen.tap(cx, cy);
  await assertDismissed('a fresh tap after cancellation closes normally');

  await page.evaluate(() => test.open());
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  await touch('touchMove', [[cx - 100, cy], [cx + 100, cy]]);
  await touch('touchEnd', []);
  await page.evaluate(() => test.render());
  const beforeX = await page.evaluate(() => test.backCalls);
  await page.click('.lightbox-x');
  assert(!(await open()), 'the close button works immediately after a pinch and render');
  assert.equal(await page.evaluate(() => test.backCalls), beforeX + 1, 'close button navigates exactly once');
  // desktop: the wheel zooms toward the cursor
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluate(() => test.open()); await page.waitForSelector('.lightbox img');
  await page.mouse.move(700, 400);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(30); }
  z = await zoom();
  assert(z.s > 1.5, 'the wheel zooms in: ' + JSON.stringify(z));
  assert(await open(), 'wheel zoom leaves the picture open');
  await page.mouse.click(700, 400);
  await assertDismissed('a desktop click closes the wheel-zoomed picture immediately');
  assert.deepEqual(errors, []);
  console.log('✓ Pinch zoom, clamped panning and wheel zoom work; background renders preserve zoom');
  console.log('✓ Taps close immediately at every zoom, before slow navigation; backdrop and close button work');
  console.log('✓ Pinches, two-finger touches and cancellations stay open; a fresh tap dismisses; no browser errors');
} finally { await browser.close(); server.stop(true); }
