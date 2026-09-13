// Two things about the front door.
//
// One: making your own keys has to look like the way in. Four equally
// weighted buttons, where only the sign-in ones said what they did, sent
// people straight past the seed phrase — which IS the wallet — into a login
// that is only a convenience wrapped around one.
//
// Two: a wallet that arrived by SIGN-IN has a recovery phrase its owner has
// never seen, and nobody can reissue it. So it gets shown once, during
// setup, and if they put it off the wallet keeps one quiet line about it.
//
// Run: bun tools/onboard-backup-test.js
import puppeteer from 'puppeteer-core';
import { bech32 } from '@scure/base';
import { generateSecretKey } from 'nostr-tools/pure';
import { seedFromNostrKey } from '../src/nostr-login.js';
import { buildHtml } from '../build.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };

const html = await buildHtml({ minify: true, pwa: false });
const server = Bun.serve({ port: 5291, fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });

const click = (page, t, sel = 'button') => page.evaluate((s, x) => {
  const e = [...document.querySelectorAll(s)].find((n) => n.textContent.trim().toLowerCase().includes(x));
  if (e) { e.click(); return true; } return false;
}, sel, t.toLowerCase());
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = async (page, x, ms = 30000) => {
  for (let i = 0; i < ms / 250; i++) { if ((await text(page)).toLowerCase().includes(x.toLowerCase())) return true; await sleep(250); }
  return false;
};

// Sign in with a pasted nsec and stop at whatever the wizard shows next.
// Its own browser context, so each run meets a genuinely fresh front door
// rather than the wallet the previous one left in localStorage.
async function signIn() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5291/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('btc-wallet-network', 'regtest'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  // wait for the front door to actually be painted before poking it
  await waitText(page, 'sign in with nostr');
  const sk = generateSecretKey();
  const nsec = bech32.encode('nsec', bech32.toWords(sk), 1000);
  await click(page, 'sign in with nostr');
  await waitText(page, 'log in with nostr');
  await page.waitForSelector('input[placeholder*="nsec" i], textarea[placeholder*="nsec" i]', { timeout: 15000 });
  await page.type('input[placeholder*="nsec" i], textarea[placeholder*="nsec" i]', nsec);
  await click(page, 'log in');
  return { page, ctx, seed: seedFromNostrKey(sk) };
}

try {
  console.log('[the start page]');
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto('http://localhost:5291/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const front = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent);
      const primary = document.getElementById('onb-create');
      const idx = btns.indexOf(primary);
      const signins = btns.filter((b) => /sign in with/i.test(b.textContent));
      return {
        label: primary ? primary.textContent.trim() : null,
        first: idx === 0 || (idx >= 0 && idx < btns.findIndex((b) => /sign in with/i.test(b.textContent))),
        primaryTop: primary ? primary.getBoundingClientRect().top : -1,
        signinTop: signins.length ? signins[0].getBoundingClientRect().top : -1,
        divider: !!document.querySelector('.onb-or'),
        body: (document.querySelector('.onb p') || {}).textContent || '',
      };
    });
    check('the way in says what it makes', /wallet/i.test(front.label || ''), front.label || 'missing');
    check('...and comes before the sign-in buttons', front.first && front.primaryTop < front.signinTop,
      `create at ${Math.round(front.primaryTop)}, first sign-in at ${Math.round(front.signinTop)}`);
    check('...with a line between them, so they read as the alternative', front.divider);
    check('the page says what the wallet actually is', /twelve words|seed|phrase/i.test(front.body),
      front.body.slice(0, 60) + '…');
    await page.close();
  }

  console.log('\n[signing in, then writing it down]');
  {
    const { page, ctx, seed } = await signIn();
    check('a sign-in is asked to write the phrase down', await waitText(page, 'write down your recovery phrase'));
    const shown = await page.evaluate(() => [...document.querySelectorAll('.words .w .t')].map((e) => e.textContent.trim()));
    check('...and the real twelve words are on screen', shown.length === 12 && shown.join(' ') === seed,
      shown.length + ' words' + (shown.join(' ') === seed ? ', matching the derived seed' : ', WRONG'));
    await click(page, "i've written it down");
    check('confirming lands in the wallet', await waitText(page, 'receive'));
    const nag = await text(page);
    check('...and there is no reminder afterwards', !/still unwritten/i.test(nag));
    await page.reload({ waitUntil: 'domcontentloaded' });
    check('...not after a reload either', await waitText(page, 'receive') && !/still unwritten/i.test(await text(page)));
    await ctx.close();
  }

  console.log('\n[signing in, then putting it off]');
  {
    const { page, ctx } = await signIn();
    check('the ask appears', await waitText(page, 'write down your recovery phrase'));
    await click(page, 'later');
    check('later lands in the wallet too', await waitText(page, 'receive'));
    check('...but the wallet keeps a quiet reminder', /still unwritten/i.test(await text(page)));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitText(page, 'receive');
    check('...which survives a reload', /still unwritten/i.test(await text(page)));
    // and it is a way IN, not just a scold
    await click(page, 'write it down');
    check('tapping it opens the recovery phrase', await waitText(page, 'recovery phrase'));
    await ctx.close();
  }
} finally { await browser.close(); server.stop(true); }
console.log(ok ? '\n✅ the front door points at your own keys' : '\n❌ failed');
process.exit(ok ? 0 : 1);
