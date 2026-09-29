// Real feed/navigation views with local posts and no relay traffic.
// Run: bun tools/feed-bottom-nav-test.js
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
function render() { if (feature) morphChildren(document.querySelector('#app'), [feature.screenView()]); }
feature = messagesFeature({ h, ui, wallet, render, toast() {}, hook() {}, brandHeader: () => h('div', { style: 'height:60px' }, 'Coinos') });
window.test = { ui, wallet, render, async feed() {
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
  build.onLoad({filter:/src\/features\/messages\.js$/},async({path})=>({loader:'js',contents:(await Bun.file(path).text()).replace("id: 'messages',", "id: 'messages', testSeed: async (notes) => { const c = feedNow(); await c.boot; Object.assign(c, { notes, status: 'ready', booting: false, end: true, shown: 20 }); }, testUnseen: () => { feed.unseen = 2; },")}));
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
const scroll=async()=>{ await page.evaluate(()=>window.scrollTo(0,700)); await page.waitForFunction(()=>!document.querySelector('.feed-bottom-nav')?.hidden); };
try {
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(server.url.href);
  await page.waitForSelector('.note-post', {timeout:5000});
  assert(await page.$eval('.feed-bottom-nav',e=>e.hidden),'hidden at top');
  await scroll();
  assert.deepEqual(await page.$$eval('.feed-nav-button',els=>els.map(e=>e.textContent)),['Home','Messages','Notifications']);
  assert(await page.$eval('.feed-bottom-nav',e=>Math.abs(e.getBoundingClientRect().bottom-innerHeight)<1),'fixed at viewport bottom');
  await page.evaluate(()=>test.unseen());
  assert(await page.evaluate(()=>document.querySelector('.feed-new-pill').getBoundingClientRect().bottom < document.querySelector('.feed-bottom-nav').getBoundingClientRect().top),'new posts pill stays above navigation');
  await page.screenshot({path:'/tmp/feed-bottom-nav-mobile.png'});
  await page.tap('.feed-nav-button:nth-child(1)');
  await page.waitForFunction(()=>scrollY===0 && document.querySelector('.feed-bottom-nav').hidden);
  assert.equal(await page.evaluate(()=>test.ui.msgView),'feed','Home stays in feed');
  await scroll(); await page.tap('.feed-nav-button:nth-child(2)');
  await page.waitForFunction(()=>test.ui.msgView==='home' && !document.querySelector('.feed-bottom-nav'));
  assert((await page.evaluate(()=>document.body.innerText)).includes('Messages'),'chat list renders');
  await page.evaluate(()=>test.feed()); await scroll(); await page.tap('.feed-nav-button:nth-child(3)');
  await page.waitForFunction(()=>test.ui.msgView==='notifs' && !document.querySelector('.feed-bottom-nav'));
  assert((await page.evaluate(()=>document.body.innerText)).includes('Notifications'),'notifications render');
  await page.evaluate(()=>test.feed()); await scroll(); await page.tap('.note-text');
  await page.waitForFunction(()=>!!test.ui.noteThread && !document.querySelector('.feed-bottom-nav'));
  await page.evaluate(()=>test.feed());
  await page.evaluate(()=>{test.wallet.xpub=null;test.render();}); await scroll();
  await page.tap('.feed-nav-button:nth-child(2)');
  assert(await page.evaluate(()=>test.ui.signinAsk && test.ui.msgView==='feed'),'visitor gets sign-in prompt');
  assert.deepEqual(errors,[]);
  console.log('✓ Feed nav appears on scroll; Home returns to top; Messages and Notifications open their views; nav leaves threads; visitor sign-in and new-post pill work');
} finally { await page.close(); if (remote) await browser.disconnect(); else await browser.close(); server.stop(true); }
