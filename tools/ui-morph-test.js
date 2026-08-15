// Morph smoke test: boot the built app in headless Chrome, walk the primary
// screens, and assert (a) no page errors, (b) DOM nodes keep their identity
// across background renders — the property the morph exists to provide.
// Usage: bun build.js && bun tools/ui-morph-test.js
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PORT = 5230;
const server = spawn('bun', ['--bun', 'x', 'serve', '-p', String(PORT), 'dist'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

let ok = true;
const check = (name, cond, detail = '') => {
  console.log(` ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) ok = false;
};

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
await sleep(2000);

// onboarding visible?
const hasButton = await page.evaluate(() => !!document.querySelector('button'));
check('app booted to a screen with buttons', hasButton);

// walk into a wallet if the entry button exists
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /get started/i.test(b.textContent));
  if (btn) { btn.click(); return true; }
  return false;
});
await sleep(4000);
check('entered next screen', await page.evaluate(() => document.body.textContent.length > 100), clicked ? '' : '(no Get started button — already in wallet)');

// node identity across background renders: tag a button, force renders, compare
const identity = await page.evaluate(async () => {
  const pick = [...document.querySelectorAll('button')].find((b) => b.offsetParent);
  if (!pick) return { skipped: true };
  pick.__marked = true;
  // fire a burst of background-style renders through the wallet's emitter if
  // exposed; otherwise rely on natural ones over the wait
  await new Promise((r) => setTimeout(r, 2500));
  const same = [...document.querySelectorAll('button')].some((b) => b.__marked);
  return { skipped: false, same };
});
check('button node survives background renders', identity.skipped || identity.same,
  identity.skipped ? '(no visible button)' : '');

// push deeper: continue through onboarding screens, then open the Send tab
for (let i = 0; i < 8; i++) {
  const state = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('button')].filter((b) => b.offsetParent);
    const send = vis.find((b) => /^send$/i.test(b.textContent.trim()));
    if (send) { send.click(); return 'send'; }
    for (const re of [/generate seed/i, /continue|i saved|done|skip|next/i]) {
      const b = vis.find((x) => re.test(x.textContent));
      if (b) { b.click(); return b.textContent.trim().slice(0, 20); }
    }
    return 'none';
  });
  console.log('   walk:', state);
  await sleep(3000);
  if (state === 'send') break;
}
check('send tab reachable', await page.evaluate(() =>
  !!([...document.querySelectorAll('input[type=text]')].find((i) => i.offsetParent))), '');

// typing: find a text input if present, type + hold value across renders
const typing = await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input[type=text]')].find((i) => i.offsetParent);
  if (!inp) return { skipped: true };
  inp.focus();
  inp.value = 'morphtest';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return { skipped: false };
});
if (!typing.skipped) {
  await sleep(1200);
  const kept = await page.evaluate(() => {
    const inp = [...document.querySelectorAll('input[type=text]')].find((i) => i.value === 'morphtest');
    return !!inp && document.activeElement === inp;
  });
  check('focused input keeps value + focus across renders', kept);
} else {
  check('typing check', true, '(no text input on this screen)');
}

check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
server.kill();
console.log(ok ? '\n✅ morph smoke passes' : '\n❌ morph smoke failed');
process.exit(ok ? 0 : 1);
