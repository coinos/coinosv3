// You must always be able to type. The chat card is sized to the viewport and
// only the message log flexes, so the header, an open invite or member panel,
// and a long backlog all shrink the scroll area rather than pushing the
// composer below the fold.
//
// Run: bun tools/chat-layout-test.js
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the shot goes somewhere every machine has, not one session's scratch dir
const shotPath = join(tmpdir(), 'chat-layout.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5229, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const setInput = (sel, v) => page.evaluate((s, val) => { const e = document.querySelector(s); if (!e) return false; e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); return true; }, sel, v);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };

// Is the composer fully inside the window, without scrolling?
const composerFits = () => page.evaluate(() => {
  const c = document.querySelector('.chat-compose');
  if (!c) return { found: false };
  const r = c.getBoundingClientRect();
  return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, fits: r.bottom <= window.innerHeight && r.top >= 0 };
});

try {
  for (const vp of [{ width: 1280, height: 800, name: 'laptop' }, { width: 390, height: 844, name: 'phone' }, { width: 1024, height: 600, name: 'short laptop' }, { width: 390, height: 400, name: 'phone with keyboard' }, { width: 844, height: 390, name: 'landscape phone' }]) {
    console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
    await page.setViewport({ width: vp.width, height: vp.height });
    if (vp.name === 'laptop') {
      await page.goto('http://localhost:5229/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(400);
      await click('button', 'Create a new wallet');
      await sleep(300);
      await click('button', 'Have an existing seed');
      await sleep(300);
      await page.waitForSelector('textarea');
      await page.type('textarea', generateMnemonic(wordlist));
      await click('button', 'Open wallet');
      await waitText('receive', 15000);
      // .header-msgs is the shared header-button class — settings, lock and
      // search wear it too, and the first one is no longer this one
      await page.evaluate(() => [...document.querySelectorAll('button')]
        .find((b) => /message/i.test(b.getAttribute('aria-label') || ''))?.click());
      await sleep(800);
      await click('button', 'Create');
      await sleep(300);
      await setInput('input[placeholder*="name" i]', 'layout test');
      await sleep(200);
      await page.evaluate(() => { const i = document.querySelector('input[placeholder*="name" i]'); const b = i && i.parentElement.querySelector('button'); if (b) b.click(); });
      await waitText('layout test', 25000);
      await click('.item', 'layout test');
      await sleep(2000);
    }
    await sleep(600);

    let r = await composerFits();
    check('composer is on screen', r.found && r.fits, `bottom ${r.bottom} of ${r.vh}`);

    // the state from the report: the invite panel open above the log
    await page.evaluate(() => { const b = [...document.querySelectorAll('.chat-head button')].find((e) => /add person/i.test(e.textContent)); if (b) b.click(); });
    await sleep(600);
    const panelOpen = await page.$('.chat-invite');
    r = await composerFits();
    check('...and still on screen with the invite panel open', !!panelOpen && r.fits, `bottom ${r.bottom} of ${r.vh}`);

    // and with the member list open too
    await page.evaluate(() => { const e = [...document.querySelectorAll('.chat-head .col')].find((n) => n.className.includes('clickable')); if (e) e.click(); });
    await sleep(600);
    r = await composerFits();
    check('...and with the member list open as well', r.fits, `bottom ${r.bottom} of ${r.vh}`);

    const frame = await page.evaluate(() => {
      const footer = document.querySelector('.footer');
      const head = document.querySelector('.chat-head').getBoundingClientRect();
      return {
        footerHidden: !footer || getComputedStyle(footer).display === 'none',
        pageFits: document.documentElement.scrollHeight <= innerHeight,
        headerFits: head.top >= 0 && head.bottom <= innerHeight,
      };
    });
    check('footer hidden, header visible, and no page scrolling', frame.footerHidden && frame.pageFits && frame.headerFits, JSON.stringify(frame));

    // put it back for the next viewport
    await page.evaluate(() => { const e = [...document.querySelectorAll('.chat-head .col')].find((n) => n.className.includes('clickable')); if (e) e.click(); });
    await sleep(300);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.chat-head button')].find((e) => /add person/i.test(e.textContent)); if (b) b.click(); });
    await sleep(300);

    const pinned = await page.evaluate(() => {
      const log = document.querySelector('.chat-log');
      const head = document.querySelector('.chat-head');
      const compose = document.querySelector('.chat-compose');
      const headTop = head.getBoundingClientRect().top;
      const composeTop = compose.getBoundingClientRect().top;
      const backlog = document.createElement('div');
      backlog.style.cssText = 'height:3000px;flex-shrink:0';
      log.append(backlog);
      log.scrollTop = log.scrollHeight;
      const result = log.scrollTop > 0 && head.getBoundingClientRect().top === headTop
        && compose.getBoundingClientRect().top === composeTop
        && document.documentElement.scrollHeight <= innerHeight;
      backlog.remove();
      return result;
    });
    check('a long message history scrolls with the name and composer pinned', pinned);
  }
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(500);
  await page.screenshot({ path: shotPath });

  console.log('\n[the channel header]');
  const one = await page.evaluate(() => ({
    picker: !!document.querySelector('.chan-pick'),
    named: document.body.innerText.includes('#general'),
    placeholder: (document.querySelector('#msg-draft') || {}).placeholder,
  }));
  check('a single channel is not named', !one.picker && !one.named, JSON.stringify(one));
  check('and the composer says just "Message"', /^Message/.test(one.placeholder || '') && !/#/.test(one.placeholder || ''), one.placeholder);

  console.log('\n[adding a channel]');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.chat-head button')].find((e) => /add person/i.test(e.textContent)); if (b) b.click(); });
  await sleep(600);
  const gated = await page.evaluate(() => ({
    field: !!document.querySelector('input[placeholder*="channel" i]'),
    button: [...document.querySelectorAll('.chat-invite button')].some((b) => /new channel/i.test(b.textContent)),
  }));
  check('the naming field is not just sitting there', !gated.field, JSON.stringify(gated));
  check('there is a New channel button instead', gated.button);

  await click('.chat-invite button', 'New channel');
  await sleep(500);
  check('which reveals the field', !!(await page.$('input[placeholder*="channel" i]')));
  await setInput('input[placeholder*="channel" i]', 'random');
  await sleep(200);
  await page.evaluate(() => { const i = document.querySelector('input[placeholder*="channel" i]'); const b = i && i.parentElement.querySelector('button'); if (b) b.click(); });

  for (let i = 0; i < 60 && !(await page.$('.chan-pick')); i++) await sleep(500);
  // the picker appears on the relay echo, which can beat createChannel's own
  // continuation — give the field a moment to put itself away
  for (let i = 0; i < 20 && (await page.$('input[placeholder*="channel" i]')); i++) await sleep(500);
  const two = await page.evaluate(() => {
    const sel = document.querySelector('.chan-pick');
    return { picker: !!sel, tag: sel && sel.tagName, opts: sel ? [...sel.options].map((o) => o.textContent) : [], field: !!document.querySelector('input[placeholder*="channel" i]') };
  });
  check('two channels become a select', two.picker && two.tag === 'SELECT' && two.opts.length === 2, JSON.stringify(two.opts));
  check('and the naming field puts itself away', !two.field);
  const r2 = await composerFits();
  check('composer still on screen', r2.fits, `bottom ${r2.bottom} of ${r2.vh}`);

  console.log('\n[direct messages]');
  await page.click('.chat-back');
  await sleep(500);
  check('footer returns when the conversation closes', await page.$eval('.footer', (el) => getComputedStyle(el).display !== 'none'));
  await click('button', 'New message');
  await setInput('input[placeholder*="npub" i]', '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  await click('button', 'Open');
  await page.waitForSelector('.chat-compose');
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  const dm = await composerFits();
  check('DM composer fits and footer is hidden', dm.fits && await page.$eval('.footer', (el) => getComputedStyle(el).display === 'none'));
  const keyboard = await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 400 });
    window.visualViewport.dispatchEvent(new Event('resize'));
    const bottom = document.querySelector('.chat-compose').getBoundingClientRect().bottom;
    delete window.visualViewport.height;
    window.visualViewport.dispatchEvent(new Event('resize'));
    return bottom <= 400;
  });
  check('DM composer follows a keyboard that only resizes the visual viewport', keyboard);
} catch (e) {
  check('run completed', false, e.message);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(ok ? '\n✅ the composer stays put' : '\n❌ failures above');
process.exit(ok ? 0 : 1);
