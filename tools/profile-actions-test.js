// Send clears on leaving; profile Pay starts fresh; messaging Back pops history.
// Run: bun tools/profile-actions-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { cacheKeyFor } from '../src/wallet.js';
const peer = getPublicKey(generateSecretKey()), nextPeer = getPublicKey(generateSecretKey());
const searchPeer = getPublicKey(generateSecretKey());
const bundle = await Bun.build({ entrypoints: ['src/app.js'], target: 'browser', minify: true,
  plugins: [{ name: 'profile-actions-test', setup(build) {
    build.onLoad({ filter: /src\/app\.js$/ }, async ({ path }) => ({ loader: 'js', contents: await Bun.file(path).text() + `
window.profileActions = { ui, wallet, render, showSend, enterWallet, openImage: ctx.openImage,
  get ready() { return !_bootDeciding; },
  openProfile: (pk) => featureHook('openProfile', pk) };
` }));
    build.onLoad({ filter: /src\/video-compress\.js$/ }, () => ({ loader: 'js', contents: 'export async function compressVideo(f) { return f; }' }));
  } }] });
assert(bundle.success, bundle.logs.join('\n'));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const server = Bun.serve({ port: 0, fetch(req) {
  if (new URL(req.url).pathname === '/recipient-portrait.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#2685c8"/><circle cx="48" cy="40" r="22" fill="#ffcc77"/></svg>', { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
  if (/^\/punks\/\d+\.webp$/.test(new URL(req.url).pathname)) return new Response(Bun.file('static' + new URL(req.url).pathname));
  return new URL(req.url).pathname === '/' || new URL(req.url).pathname.startsWith('/npub1')
    ? new Response(html, { headers: { 'Content-Type': 'text/html' } }) : new Response(null, { status: 404 });
} });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['wss://*', 'ws://*'] });
  await page.setRequestInterception(true);
  page.on('request', (r) => r.url().startsWith(server.url.origin) || r.url().startsWith('data:') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(() => { localStorage.setItem('btc-wallet-network', 'regtest'); localStorage.setItem('btc-wallet-ark-provider:regtest', 'off'); });
  await page.evaluateOnNewDocument((pk) => localStorage.setItem('btc-wallet-search-queries-v2', JSON.stringify({
    carol: { t: Date.now(), rows: [{ pk, name: 'Carol', picture: '/recipient-portrait.svg', pri: 1 }] },
  })), searchPeer);
  await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.profileActions?.ready);
  const mnemonic = generateMnemonic(wordlist);
  await page.evaluate(([base, peer, nextPeer]) => localStorage.setItem(base + ':profiles', JSON.stringify({
    [peer]: { name: 'Alice', picture: '/punks/18.webp', t: Date.now() },
    [nextPeer]: { name: 'Bob', picture: '/punks/54.webp', t: Date.now() },
  })), [cacheKeyFor(mnemonic + '\n'), peer, nextPeer]);
  await page.evaluate(async (mn) => {
    await profileActions.enterWallet(mn, '', { fresh: true, generated: true });
    profileActions.ui.onb = null;
    localStorage.removeItem('btc-wallet-onb-step');
    profileActions.render();
  }, mnemonic);
  await page.waitForSelector('.app-bottom-nav');
  // Search owns a separate profile cache. A cold portrait cache must inherit
  // the suggestion's metadata and fetch the large image before selection.
  await page.evaluate(() => { profileActions.showSend({ fresh: true }); profileActions.render(); });
  const portraitResponse = page.waitForResponse(r => r.url().endsWith('/recipient-portrait.svg'));
  await page.type('textarea.send-dest', 'carol');
  await page.waitForSelector('.send-suggest .ava-img');
  await portraitResponse;
  await page.evaluate(() => {
    window.recipientFrames = [];
    const record = () => {
      const a = document.querySelector('.send-avatar');
      if (a) recipientFrames.push({ punk: !!a.querySelector('.punk'), hidden: getComputedStyle(a).visibility === 'hidden', picture: a.style.backgroundImage });
    };
    window.recipientObserver = new MutationObserver(record);
    recipientObserver.observe(document.querySelector('#app'), { subtree: true, childList: true, attributes: true });
  });
  await page.click('.send-suggest .chat-thread-row');
  await page.waitForSelector('.send-avatar');
  assert.equal(await page.$eval('textarea.send-dest', e => e.value), npubEncode(searchPeer));
  assert(await page.$eval('.send-avatar', e => e.classList.contains('ava-img') && e.style.backgroundImage.includes('/recipient-portrait.svg') && getComputedStyle(e).visibility !== 'hidden'), 'selection immediately uses the already-fetched suggestion portrait');
  assert(await page.evaluate(() => recipientFrames.length > 0 && recipientFrames.every(f => !f.punk && !f.hidden && f.picture.includes('/recipient-portrait.svg'))), 'every selected-recipient frame has the real avatar, without fallback or placeholder');
  await page.evaluate(() => recipientObserver.disconnect());
  console.log('✓ Autosuggest warms the large recipient picture before selection and displays it immediately');
  const openProfile = async (pk) => {
    await page.evaluate((pk) => profileActions.openProfile(pk), pk);
    await page.waitForSelector('.prof-actions');
  };
  const action = (label) => page.evaluate((label) => [...document.querySelectorAll('.prof-actions button')].find((b) => b.textContent.trim().replace(/^⚡\s*/, '') === label).click(), label);

  // Exercise each real success view without making any payment.
  const successes = [
    { sendResult: { txid: '1'.repeat(64) } },
    { arkLnPaid: { amountSat: 21, meta: { name: 'Previous person' } } },
    { arkZapped: { amountSat: 21, npub: npubEncode(peer) } },
    { arkSent: { amountSat: 21 } },
  ];
  for (const previous of successes) {
    await page.evaluate((previous) => {
      const { ui, render, showSend } = profileActions;
      ui.profilePk = null; ui.chatOpen = false;
      showSend({ fresh: true });
      Object.assign(ui, previous);
      render();
    }, previous);
    assert.equal(await page.$('textarea.send-dest'), null, 'previous payment displays its success view');
    await openProfile(nextPeer);
    await action('Pay');
    await page.waitForSelector('textarea.send-dest');
    assert.equal(await page.$eval('textarea.send-dest', (e) => e.value), npubEncode(nextPeer));
    assert(!(await page.$('.check-badge')), 'previous success must not win over the new payment form');
    const state = await page.evaluate(() => ({
      recipients: profileActions.ui.send.recipients.map(({ address, amount }) => ({ address, amount })),
      results: ['sendResult', 'arkLnPaid', 'arkZapped', 'arkSent'].map((k) => profileActions.ui[k]),
    }));
    assert.deepEqual(state.recipients, [{ address: npubEncode(nextPeer), amount: '' }]);
    assert(state.results.every((v) => v === null));
  }
  console.log('✓ Profile Pay replaces prior on-chain, Lightning, zap and Ark success screens with a fresh recipient form');

  await openProfile(peer);
  await page.evaluate(() => {
    const { ui } = profileActions;
    ui.send.recipients = [{ address: 'old person', amount: '5' }, { address: 'another old person', amount: '7' }];
    ui.send.max = true;
    ui.draft = { stale: true }; ui.broadcastTx = { stale: true }; ui.sendError = 'Previous error';
    ui.arkSend = { stale: true }; ui.arkLnPay = { stale: true }; ui.arkZap = { stale: true };
    ui.arkLnFromSavings = { stale: true }; ui.arkLnFromSavingsOk = true; ui.arkOffboardSend = { stale: true };
    ui.zap = { stale: true }; ui.nameResolve = { text: 'old@example.test' };
  });
  await action('Pay');
  await page.waitForSelector('textarea.send-dest');
  assert.equal(await page.$eval('textarea.send-dest', (e) => e.value), npubEncode(peer));
  assert(await page.evaluate(() => {
    const { ui } = profileActions;
    return !ui.send.max && !ui.arkLnFromSavingsOk && ui.send.recipients.length === 1 && ui.send.recipients[0].amount === ''
      && ['draft', 'broadcastTx', 'arkSend', 'arkLnPay', 'arkZap', 'arkLnFromSavings', 'arkOffboardSend', 'zap', 'nameResolve', 'sendError'].every((k) => !ui[k]);
  }), 'old review, resolution, amount, max and extra recipients are cleared');
  console.log('✓ Fresh profile payment also clears prior drafts and recipient amounts');

  const portrait = await page.$eval('.send-person', (e) => {
    const a = e.querySelector('.send-avatar').getBoundingClientRect(), name = e.querySelector('span').getBoundingClientRect();
    const card = e.closest('.card').getBoundingClientRect(), style = getComputedStyle(e);
    return { width: a.width, height: a.height, centered: Math.abs(a.x + a.width / 2 - card.x - card.width / 2) < 1,
      nameBelow: name.top >= a.bottom, border: style.borderWidth, background: style.backgroundColor, name: e.textContent };
  });
  assert.deepEqual(portrait, { width: 96, height: 96, centered: true, nameBelow: true, border: '0px', background: 'rgba(0, 0, 0, 0)', name: 'Alice' });
  await page.screenshot({ path: '/tmp/coinos-send-profile.png' });
  console.log('✓ Recipient portrait is 96px, centered above the name, without a badge border or background');

  const assertBlank = async () => {
    assert(await page.evaluate(() => {
      const { ui } = profileActions;
      return ui.send.recipients.length === 1 && ui.send.recipients[0].address === '' && ui.send.recipients[0].amount === ''
        && !ui.send.max && ui.send.coins.size === 0 && !ui.arkLnFromSavingsOk
        && ['draft', 'broadcastTx', 'sendResult', 'sendError', 'arkSend', 'arkSent', 'arkLnPay', 'arkLnPaid', 'arkZap', 'arkZapped',
          'arkLnFromSavings', 'arkOffboardSend', 'zap', 'nameResolve'].every((k) => !ui[k]);
    }), 'leaving Send clears the recipient, amount, selection, drafts and all feature payment states');
  };
  const pendingSend = async () => {
    await page.evaluate((npub) => {
      const { ui, render, showSend } = profileActions;
      ui.profilePk = null; ui.chatOpen = false; ui.msgView = null;
      showSend({ fresh: true });
      ui.send.recipients[0] = { address: npub, amount: '21' };
      render(); render();
    }, npubEncode(peer));
    assert.deepEqual(await page.evaluate(() => profileActions.ui.send.recipients.map(({ address, amount }) => ({ address, amount }))),
      [{ address: npubEncode(peer), amount: '21' }], 'background renders retain an in-progress payment on Send');
    // Stale hidden feature state is deliberately seeded after painting the form.
    await page.evaluate(() => {
      const { ui } = profileActions;
      ui.draft = { stale: true }; ui.broadcastTx = { stale: true }; ui.sendResult = { stale: true }; ui.sendError = 'Previous error';
      ui.arkSend = { stale: true }; ui.arkSent = { stale: true }; ui.arkLnPay = { stale: true }; ui.arkLnPaid = { stale: true };
      ui.arkZap = { stale: true }; ui.arkZapped = { stale: true }; ui.arkLnFromSavings = { stale: true };
      ui.arkLnFromSavingsOk = true; ui.arkOffboardSend = { stale: true }; ui.zap = { stale: true }; ui.nameResolve = { text: 'old@example.test' };
    });
  };
  for (const label of ['Wallet', 'Messages', 'Feed', 'Notifications']) {
    await pendingSend();
    await page.evaluate((label) => document.querySelector(`.app-nav-button[aria-label="${label}"]`).click(), label);
    await assertBlank();
  }
  await pendingSend();
  await page.evaluate(() => document.querySelector('.send-person').click());
  await page.waitForSelector('.prof-actions');
  assert.equal(await page.evaluate(() => profileActions.ui.profilePk), peer);
  await assertBlank();
  await page.goBack();
  await page.waitForSelector('textarea.send-dest');
  await assertBlank();
  assert.equal(await page.$('.send-person'), null, 'returning to Send has no old recipient portrait');

  // Native Back/Forward also leave and reopen the Send pane, without a draft.
  await page.evaluate(() => { const { ui, render } = profileActions; ui.tab = 'receive'; render(); });
  await pendingSend();
  await page.goBack();
  await page.waitForFunction(() => profileActions.ui.tab === 'receive');
  await assertBlank();
  await page.goForward();
  await page.waitForSelector('textarea.send-dest');
  await assertBlank();
  console.log('✓ Leaving Send for navigation tabs, a recipient profile or browser Back clears it; returning starts blank');

  await openProfile(peer);
  const before = await page.evaluate(() => ({ i: history.state.i, length: history.length, path: location.pathname }));
  await action('Messages');
  await page.waitForSelector('.chat-head .chat-back');
  assert.equal(await page.evaluate(() => profileActions.ui.msgPeer), peer);
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.anim-page')].flatMap((n) => n.getAnimations()).map((a) => a.finished.catch(() => {}))));
  await page.click('.chat-head .chat-back');
  await page.waitForSelector('.prof-actions');
  assert.equal(await page.evaluate(() => profileActions.ui.profilePk), peer);
  assert.deepEqual(await page.evaluate(() => ({ i: history.state.i, length: history.length, path: location.pathname })), { ...before, length: before.length + 1 },
    'on-screen Back pops the DM entry and restores the exact profile history entry');
  await page.goForward();
  await page.waitForSelector('.chat-head .chat-back');
  assert.equal(await page.evaluate(() => profileActions.ui.profilePk), null);
  assert.equal(await page.evaluate(() => profileActions.ui.msgPeer), peer);
  await page.goBack();
  await page.waitForSelector('.prof-actions');
  assert.equal(await page.evaluate(() => profileActions.ui.profilePk), peer);
  console.log('✓ Messaging Back returns to its profile, and native browser Forward/Back traverse the same entries');

  // A conversation opened from the chat list still returns to that list.
  await page.evaluate((peer) => {
    const { ui, render } = profileActions;
    ui.profilePk = null; ui.chatOpen = true; ui.msgView = 'home'; render();
    ui.msgView = 'dm'; ui.msgPeer = peer; render();
  }, nextPeer);
  await page.waitForSelector('.chat-head .chat-back');
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.anim-page')].flatMap((n) => n.getAnimations()).map((a) => a.finished.catch(() => {}))));
  await page.click('.chat-head .chat-back');
  await page.waitForFunction(() => profileActions.ui.msgView === 'home');
  assert.equal(await page.evaluate(() => profileActions.ui.profilePk), null);
  console.log('✓ Conversations opened from the chat list return to it');

  // Photo dismissal removes the overlay synchronously, then pops its history
  // entry. Background morphs must keep the handler tied to the mounted box.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const photoParent = await page.evaluate(() => ({ i: history.state.i, nav: history.state.nav, path: location.pathname }));
  await page.evaluate(() => { profileActions.openImage('/recipient-portrait.svg'); profileActions.render(); });
  await page.waitForSelector('.lightbox img');
  assert.equal(await page.evaluate(() => history.state.i), photoParent.i + 1);
  await page.evaluate(() => document.addEventListener('click', () => {
    window.photoClosedDuringClick = !document.querySelector('.lightbox') && !document.documentElement.classList.contains('no-scroll');
  }, { once: true }));
  const photoCenter = await page.$eval('.lightbox img', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.touchscreen.tap(photoCenter.x, photoCenter.y);
  assert(await page.evaluate(() => photoClosedDuringClick), 'photo and scroll lock disappear during the tap, without waiting for popstate');
  await page.waitForFunction(i => history.state.i === i && !document.querySelector('.lightbox'), {}, photoParent.i);
  assert.deepEqual(await page.evaluate(() => ({ i: history.state.i, nav: history.state.nav, path: location.pathname })), photoParent,
    'photo dismissal restores the exact originating page');
  await page.goForward();
  await page.waitForSelector('.lightbox');
  assert(await page.evaluate(() => !!profileActions.ui.lightbox && document.documentElement.classList.contains('no-scroll')), 'Forward reopens the viewer and locks scrolling');
  await page.goBack();
  await page.waitForFunction(() => !profileActions.ui.lightbox && !document.querySelector('.lightbox') && !document.documentElement.classList.contains('no-scroll'));
  assert.equal(await page.evaluate(() => history.state.i), photoParent.i);
  assert.deepEqual(errors, []);
  console.log('✓ Photo tap dismisses immediately after a render, restores its originating page, and preserves native Back/Forward; no browser errors');
} finally { await browser.close(); server.stop(true); }
