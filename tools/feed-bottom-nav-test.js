// Real feed/navigation views with local posts and no relay traffic.
// Run: bun tools/app-bottom-nav-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf("const root = document.getElementById('app');"));
const entry = `
import { messagesFeature } from './src/features/messages.js';
${dom}
const author = 'a'.repeat(64);
const ui = { screen: 'wallet', chatOpen: true, msgView: 'feed' };
const wallet = { xpub: 'test-wallet', loaded: true, nostrRelays: () => [],
  loadFeatureState: (k, d) => k === 'follows' ? { tags: [['p', author]], at: Date.now()/1000 } : d,
  saveFeatureState() {}, registerCacheExtension() {} };
let feature;
function render() { if (feature) morphChildren(document.querySelector('#app'), [feature.screenView() || h('div', { class: 'wallet-screen' }, 'Wallet'), feature.bottomNav()]); }
feature = messagesFeature({ h, ui, wallet, render, toast() {}, hook: name => name === 'unreadMessages' ? 1 : null, brandHeader: () => h('div', { style: 'height:60px' }, 'Coinos') });
window.test = { ui, wallet, render, get feature() { return feature; }, async feed() {
  ui.chatOpen = true; ui.msgView = 'feed'; ui.noteThread = null;
  await feature.testSeed(Array.from({length:20}, (_, i) => ({ id: i.toString(16).padStart(64,'0'), pubkey:author, kind:1, tags:[], created_at:Math.floor(Date.now()/1000)-i,
    content: 'A post in the feed. Scroll to keep Home, messages and notifications within reach. '.repeat(3) })));
  render(); window.scrollTo(0,0);
}, unseen() { feature.testUnseen(); render(); } };
await test.feed();
`;
const bundle = await Bun.build({ entrypoints: ['nav-test-entry'], target: 'browser', plugins: [{ name: 'nav-test', setup(build) {
  build.onResolve({filter:/^nav-test-entry$/},()=>({path:'entry',namespace:'nav-test'}));
  build.onLoad({filter:/.*/,namespace:'nav-test'},()=>({contents:entry,loader:'js',resolveDir:process.cwd()}));
  build.onLoad({filter:/src\/features\/messages\.js$/},async({path})=>({loader:'js',contents:(await Bun.file(path).text()).replace("id: 'messages',", "id: 'messages', testSeed: async (notes) => { const c = feedNow(); await c.boot; Object.assign(c, { notes, status: 'ready', booting: false, end: true, shown: 20 }); }, testUnseen: () => { feed.unseen = 2; }, testChats: (n, m) => { stCache = null; if (m != null) st().communities = Array.from({ length: m }, (_, i) => ({ ...COMMUNITY, community_id: (i + 1).toString(16).padStart(64, 'd'), name: 'Room ' + i })); threads.clear(); for (let i = 0; i < n; i++) { const peer = (i + 1).toString(16).padStart(64, 'c'); threads.set(peer, new Map([['r' + i, { rumor: { id: 'r' + i, kind: 14, pubkey: peer, tags: [], content: 'hi ' + i, created_at: 1700000000 - i }, mine: false }]])); } },")}));
  build.onLoad({filter:/src\/nostr\.js$/},async({path})=>({loader:'js',contents:(await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {','export async function queryOn(relays, filter, maxWait = 1500) { return [];')
    .replace(/export function subscribeOn\(([^)]*)\) \{/,'export function subscribeOn($1) { return () => {};')}));
} }] });
assert(bundle.success,bundle.logs.join('\n'));
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;
const remote = !!process.env.BROWSER_URL;
const server=Bun.serve({port:remote ? 5303 : 0,fetch:()=>new Response(html,{headers:{'content-type':'text/html'}})});
const browser=remote ? await puppeteer.connect({browserURL:process.env.BROWSER_URL}) : await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage(), errors=[];
page.on('pageerror', e=>errors.push(e.message));
await page.setRequestInterception(true);
page.on('request',r=>r.url().startsWith(server.url.origin)?r.continue():r.abort());
const scroll=async()=>{ await page.evaluate(()=>window.scrollTo(0,700)); await page.waitForFunction(()=>scrollY > 0 && document.querySelector('.app-bottom-nav')?.getBoundingClientRect().height > 0); };
try {
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(server.url.href);
  await page.waitForSelector('.note-post', {timeout:5000});
  assert(await page.$eval('.app-bottom-nav',e=>!e.hidden && e.getBoundingClientRect().height>0),'visible at top without scrolling');
  await scroll();
  assert.deepEqual(await page.$$eval('.app-nav-button',els=>els.map(e=>e.textContent)),['Feed','Messages','Notifications','Wallet']);
  assert(await page.$eval('.app-bottom-nav',e=>Math.abs(e.getBoundingClientRect().bottom-innerHeight)<1),'fixed at viewport bottom');
  await page.evaluate(()=>test.unseen());
  assert(await page.evaluate(()=>document.querySelector('.feed-new-pill').getBoundingClientRect().bottom < document.querySelector('.app-bottom-nav').getBoundingClientRect().top),'new posts pill stays above navigation');
  await page.screenshot({path:'/tmp/app-bottom-nav-mobile.png'});
  await page.tap('.app-nav-button:nth-child(1)');
  await page.waitForFunction(()=>scrollY===0 && !document.querySelector('.app-bottom-nav').hidden);
  assert.equal(await page.evaluate(()=>test.ui.msgView),'feed','Feed stays in feed');
  await scroll(); await page.tap('.app-nav-button:nth-child(2)');
  await page.waitForFunction(()=>test.ui.msgView==='home' && !!document.querySelector('.app-bottom-nav'));
  assert((await page.evaluate(()=>document.body.innerText)).includes('Messages'),'chat list renders');
  assert(await page.$eval('.app-nav-button:nth-child(2)',e=>e.getAttribute('aria-current')==='page'),'messages marked active');
  const rows=()=>page.evaluate(()=>{const ls=[...document.querySelectorAll('.chat-page > .list')];return ls.map(l=>l.querySelectorAll('.chat-thread-row').length);});
  const links=()=>page.$$eval('.chat-page > button.linklike',els=>els.map(e=>e.textContent));
  await page.evaluate(()=>{const m={};const orig=test.wallet.loadFeatureState;test.wallet.loadFeatureState=(k,d)=>k==='messages'?m:orig(k,d);test.feature.testChats(4,4);test.render();});
  await page.waitForFunction(()=>document.querySelectorAll('.chat-page .chat-thread-row').length>=8);
  assert.deepEqual(await rows(),[4,4]); assert.deepEqual(await links(),['Show all 5 communities'],'four DMs show whole; five communities are gated');
  await page.evaluate(()=>{test.feature.testChats(9);test.render();});
  assert.deepEqual(await rows(),[4,4]); assert.deepEqual(await links(),['Show all 9 conversations','Show all 5 communities']);
  await page.$$eval('.chat-page > button.linklike',els=>els.forEach(e=>e.click()));
  assert.deepEqual(await rows(),[9,5]); assert.deepEqual(await links(),['Show fewer','Show fewer']);
  await page.$$eval('.chat-page > button.linklike',els=>els.forEach(e=>e.click()));
  assert.deepEqual(await rows(),[4,4],'show fewer folds both lists back');
  await page.evaluate(()=>{test.ui.msgView='dm';test.ui.msgPeer='b'.repeat(64);test.render();});
  await page.waitForSelector('.chat-card');
  assert(await page.evaluate(()=>document.querySelector('.chat-card').getBoundingClientRect().bottom <= document.querySelector('.app-bottom-nav').getBoundingClientRect().top),'conversation and composer fit above bottom nav');
  await page.screenshot({path:'/tmp/app-nav-chat.png'});
  await page.tap('.app-nav-button:nth-child(3)');
  await page.waitForFunction(()=>test.ui.msgView==='notifs' && !!document.querySelector('.app-bottom-nav'));
  assert((await page.evaluate(()=>document.body.innerText)).includes('Notifications'),'notifications render');
  await page.tap('.app-nav-button:nth-child(1)'); await scroll(); await page.tap('.note-text');
  await page.waitForFunction(()=>!!test.ui.noteThread && !!document.querySelector('.app-bottom-nav'));
  await page.tap('.app-nav-button:nth-child(1)');
  assert(await page.$eval('.app-bottom-nav',e=>!e.hidden && e.getBoundingClientRect().height>0),'returning to feed restores nav immediately without a scroll');
  await page.evaluate(()=>{test.ui.tab='settings';});
  await page.tap('.app-nav-button:nth-child(4)');
  await page.waitForSelector('.wallet-screen');
  assert(await page.evaluate(()=>!test.ui.chatOpen && test.ui.tab==='receive' && !!document.querySelector('.app-bottom-nav')),'Wallet opens main wallet instead of old settings tab');
  await page.tap('.app-nav-button:nth-child(1)');
  await page.waitForSelector('.feed-page');
  await page.setViewport({width:320,height:844,isMobile:true,hasTouch:true});
  assert(await page.$eval('.app-bottom-nav',e=>e.scrollWidth<=e.clientWidth),'four buttons fit a narrow phone');
  await page.screenshot({path:'/tmp/app-bottom-nav-always-mobile.png'});
  await page.evaluate(()=>{test.wallet.xpub=null;test.render();}); await scroll();
  await page.tap('.app-nav-button:nth-child(2)');
  assert(await page.evaluate(()=>!test.ui.chatOpen && test.ui.msgView===null),'visitor reaches sign-in screen');
  assert.deepEqual(errors,[]);
  console.log('✓ Global nav works across feed, chat list, conversations, notifications, threads and wallet; Feed restores the feed; composer remains above nav; visitor entry and narrow layout work; DMs and communities cap at four behind Show all');
} finally { await page.close(); if (remote) await browser.disconnect(); else await browser.close(); server.stop(true); }
