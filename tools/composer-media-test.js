// The reply box is <coinos-text>, a contenteditable field — the kind
// Android keyboards offer GIFs and images to (a <textarea> gets the GIF key
// greyed out). It must still type like a textarea, keep pasted text plain,
// and send a pasted/keyboard picture through the same upload as the
// paperclip, its URL landing in the draft.
//
// Run: bun tools/composer-media-test.js
import puppeteer from 'puppeteer-core';
import { cacheKeyFor } from '../src/wallet.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5279, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const uploads = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (/nostr\.download|nostr\.build/.test(u) && req.method() === 'PUT') {
    uploads.push(u);
    return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ url: 'https://nostr.download/' + 'f'.repeat(64) + '.gif', sha256: 'f'.repeat(64), size: 10, type: 'image/gif' }) });
  }
  if (/nostr\.download|nostr\.build/.test(u) && req.method() === 'OPTIONS') {
    return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, HEAD, GET', 'access-control-allow-headers': '*' } });
  }
  req.continue();
});
const click = (t) => page.evaluate((x) => { const e = [...document.querySelectorAll('button')].find((n) => n.textContent.trim().toLowerCase().includes(x)); if (e) { e.click(); return true; } return false; }, t);
const waitText = async (x, ms = 25000) => { for (let i = 0; i < ms / 250; i++) { if ((await page.evaluate(() => document.body.innerText)).toLowerCase().includes(x)) return true; await sleep(250); } return false; };
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5279/', { waitUntil: 'domcontentloaded' });
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
    localStorage.setItem(k + ':feedNotes', JSON.stringify([{ id: 'c'.repeat(64), pubkey: a, kind: 1, created_at: now, content: 'a post to answer', tags: [] }]));
    localStorage.setItem(k + ':profiles', JSON.stringify({ [a]: { name: 'Poster', t: Date.now() } }));
  }, [base, A]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitText('receive', 20000);
  await page.evaluate(() => document.querySelector('.app-bottom-nav .app-nav-button').click());
  await waitText('a post to answer', 20000);
  await page.evaluate(() => [...document.querySelectorAll('.notes-feed [data-key]')].find((n) => n.innerText.includes('a post to answer')).querySelector('button[aria-label="Reply"]').click());
  check('the reply box appears', await waitFor(() => !!document.querySelector('.thread-reply-input'), 10000));

  const box = await page.evaluate(() => { const b = document.querySelector('.thread-reply-input'); return { tag: b.tagName, ce: b.getAttribute('contenteditable'), empty: b.hasAttribute('data-empty') }; });
  check('it is the contenteditable field keyboards offer pictures to', box.tag === 'COINOS-TEXT' && box.ce === 'true', JSON.stringify(box));
  check('...showing its placeholder while empty', box.empty);

  await page.focus('.thread-reply-input');
  await page.keyboard.type('hello');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('world');
  let v = await page.evaluate(() => document.querySelector('.thread-reply-input').value);
  check('it types like a textarea, Shift+Enter a newline', v === 'hello\nworld', JSON.stringify(v));

  // pasted rich text arrives as plain text
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<b style="color:red">bold</b> <a href="x">link</a>');
    dt.setData('text/plain', ' bold link');
    document.querySelector('.thread-reply-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  v = await page.evaluate(() => ({ v: document.querySelector('.thread-reply-input').value, html: document.querySelector('.thread-reply-input').innerHTML }));
  check('pasted formatting is dropped, the text kept', v.v === 'hello\nworld bold link' && !/<b|<a /.test(v.html), JSON.stringify(v));

  // a picture from the keyboard/clipboard goes up like the paperclip's
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const gif = Uint8Array.from(atob('R0lGODlhAQABAAAAACw='), (c) => c.charCodeAt(0));
    dt.items.add(new File([gif], 'wave.gif', { type: 'image/gif' }));
    document.querySelector('.thread-reply-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const landed = await waitFor(() => /nostr\.download\/f{64}\.gif/.test(document.querySelector('.thread-reply-input')?.value || ''), 15000);
  check('a pasted GIF is uploaded and its URL lands in the reply', landed && uploads.length === 1,
    JSON.stringify(await page.evaluate(() => document.querySelector('.thread-reply-input')?.value)) + ' uploads=' + uploads.length);
  check('...and the preview shows it', await waitFor(() => !!document.querySelector('.draft-preview img, .draft-preview .note-img, .draft-preview a'), 5000));
  // the upload re-rendered the page: the field must still be editable
  await page.focus('.thread-reply-input');
  await page.evaluate(() => { const x = document.querySelector('.thread-reply-input'); x.setSelectionRange(x.value.length); });
  await page.keyboard.type(' ok');
  const after = await page.evaluate(() => ({ v: document.querySelector('.thread-reply-input').value, ce: document.querySelector('.thread-reply-input').getAttribute('contenteditable') }));
  check('after a repaint it still takes typing', after.ce === 'true' && after.v.endsWith('.gif ok'), JSON.stringify(after).slice(-60));
  const noImg = await page.evaluate(() => !document.querySelector('.thread-reply-input img'));
  check('no image element is left inside the text', noImg);
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the reply box takes pictures' : '\n❌ failed');
process.exit(ok ? 0 : 1);
