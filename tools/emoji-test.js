// Custom emoji in the coinos room: Vector's :pika_wave: messages render as
// pictures, a lone one is jumbo, the :vector_logo: reaction chip is a picture,
// the composer autocompletes a learned shortcode, and the pack link in chat
// installs the pack. Read-only: nothing is posted.
//
// Run: bun tools/emoji-test.js [screenshot.png]
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildHtml } from '../build.js';

const shotPath = process.argv[2] || '/tmp/emoji-test.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5231, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
const click = (sel, t) => page.evaluate((s, x) => { const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x.toLowerCase())); if (e) { e.click(); return true; } return false; }, sel, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; };

try {
  await page.setViewport({ width: 420, height: 860 });
  await page.goto('http://localhost:5231/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await click('button', 'Create a new wallet');
  await sleep(300);
  await click('button', 'Import existing');
  await sleep(300);
  await page.waitForSelector('textarea');
  await page.type('textarea', generateMnemonic(wordlist));
  await click('button', 'Open wallet');
  await waitText('receive', 15000);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /message/i.test(b.getAttribute('aria-label') || ''))?.click());
  await sleep(800);
  check('the coinos community is listed', await waitText('coinos', 10000));
  await page.evaluate(() => { const e = [...document.querySelectorAll('.chat-thread-row')].find((n) => (n.querySelector('.chat-name') || {}).textContent === 'coinos'); if (e) e.click(); });
  check('the GM message arrived', await waitText('GM Coinos community', 30000));
  await sleep(1500);

  console.log('\n[rendering]');
  const r = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.chat-bubble')];
    const gm = bubbles.find((b) => b.textContent.includes('GM Coinos community'));
    const kirby = bubbles.find((b) => b.querySelector('img.cemoji[alt=":kirbyrainbowglow:"]'));
    const chips = [...document.querySelectorAll('.chat-react')].filter((c) => c.querySelector('img.cemoji'));
    return {
      imgs: document.querySelectorAll('.chat-bubble img.cemoji').length,
      gmImg: !!(gm && gm.querySelector('img.cemoji[alt=":pika_wave:"]')),
      gmText: gm ? gm.textContent : '',
      kirbyJumbo: !!(kirby && kirby.classList.contains('jumbo')),
      chipImgs: chips.map((c) => c.querySelector('img').alt),
      packLink: !!document.querySelector('.pack-link button'),
      packLinkLabel: (document.querySelector('.pack-link button') || {}).textContent,
      loaded: [...document.querySelectorAll('.chat-bubble img.cemoji')].filter((i) => i.complete && i.naturalWidth > 0).length,
    };
  });
  check('custom emoji render as pictures', r.imgs > 0, `${r.imgs} imgs, ${r.loaded} loaded`);
  check(':pika_wave: is a picture and not text', r.gmImg && !r.gmText.includes(':pika_wave:'), JSON.stringify(r.gmText));
  check('a lone :kirbyrainbowglow: is jumbo', r.kirbyJumbo);
  check('a :vector_logo: reaction chip is a picture', r.chipImgs.includes(':vector_logo:'), JSON.stringify(r.chipImgs));
  check('the pack share link has an Add button', r.packLink, r.packLinkLabel);

  console.log('\n[autocomplete]');
  await page.focus('#msg-draft');
  await page.keyboard.type('hello :pik');
  await sleep(500);
  const ac = await page.evaluate(() => [...document.querySelectorAll('.emoji-ac button')].map((b) => b.title));
  await page.screenshot({ path: shotPath.replace('.png', '-ac.png') });
  check('typing :pik offers the learned pika emoji', ac.some((x) => x.includes('pika')), JSON.stringify(ac));
  await page.keyboard.press('Tab');
  await sleep(400);
  const draft = await page.evaluate(() => document.querySelector('#msg-draft').value);
  check('Tab completes the shortcode', /^hello :pika_\w+: $/.test(draft), JSON.stringify(draft));
  check('the strip closes after the pick', await page.evaluate(() => !document.querySelector('.emoji-ac button')));
  await page.evaluate(() => { const e = document.querySelector('#msg-draft'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });

  console.log('\n[adding the pack from its link]');
  await page.evaluate(() => document.querySelector('.pack-link button').click());
  check('the pack arrives', await waitText('Emoji pack added', 20000));
  await sleep(500);
  const have = await page.evaluate(() => (document.querySelector('.pack-link button') || {}).textContent);
  check('the link now says Added', have === 'Added', have);
  // the picker lists it
  await page.evaluate(() => { const b = [...document.querySelectorAll('.chat-bubble')].find((x) => x.textContent.includes('GM Coinos')); b.click(); });
  await sleep(500);
  await page.evaluate(() => document.querySelector('.msg-sheet-emojis .more').click());
  await sleep(500);
  const picker = await page.evaluate(() => ({
    custom: document.querySelectorAll('.emoji-grid img.cemoji').length,
    packs: [...document.querySelectorAll('.emoji-pack')].map((p) => p.textContent.trim()),
    state: JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith(':emoji'))) || '{}'),
  }));
  check('the picker shows custom emoji', picker.custom > 5, `${picker.custom}`);
  check('the pack is listed', picker.packs.length === 1, JSON.stringify(picker.packs));
  check('state holds the pack + learned shortcodes', picker.state.order && picker.state.order.length === 1 && Object.keys(picker.state.learned || {}).length >= 5,
    `packs ${JSON.stringify(picker.state.order)} learned ${Object.keys(picker.state.learned || {}).length}`);
  await page.screenshot({ path: shotPath });
  console.log('\nscreenshot:', shotPath);
} catch (e) {
  console.log('ERROR', e);
  ok = false;
}
await browser.close();
server.stop(true);
console.log(ok ? '\nALL GOOD' : '\nFAILURES');
process.exit(ok ? 0 : 1);
