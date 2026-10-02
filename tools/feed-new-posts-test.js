// New posts arriving mid-read: the pill lands on the OLDEST new post, and
// each new post keeps a tint until it has been in view a couple of seconds.
// Run: bun tools/feed-new-posts-test.js
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
}, arriveIds(ks) { const now = Math.floor(Date.now()/1000); feature.testArrive(ks.map((k, i) => ({ id: k.padEnd(63,'0') + String(i+1), pubkey:author, kind:1, tags:[], created_at: now + 200 - i, content: 'Waiting post ' + k }))); }, unseen() { feature.testUnseen(); render(); }, arrive(n) { const now = Math.floor(Date.now()/1000); feature.testArrive(Array.from({length:n}, (_, i) => ({ id: 'f' + i.toString(16).padStart(63,'0'), pubkey:author, kind:1, tags:[], created_at: now + 100 - i, content: 'Brand new post number ' + i + '. '.repeat(1) + 'Fresh words. '.repeat(20) }))); } };
await test.feed();
`;
const bundle = await Bun.build({ entrypoints: ['nav-test-entry'], target: 'browser', plugins: [{ name: 'nav-test', setup(build) {
  build.onResolve({filter:/^nav-test-entry$/},()=>({path:'entry',namespace:'nav-test'}));
  build.onLoad({filter:/.*/,namespace:'nav-test'},()=>({contents:entry,loader:'js',resolveDir:process.cwd()}));
  build.onLoad({filter:/src\/features\/messages\.js$/},async({path})=>({loader:'js',contents:(await Bun.file(path).text()).replace("id: 'messages',", "id: 'messages', testSeed: async (notes) => { const c = feedNow(); await c.boot; Object.assign(c, { notes, status: 'ready', booting: false, end: true, shown: 20, unseen: 0, fresh: null, deferred: [] }); }, testUnseen: () => { feed.unseen = 2; }, testArrive: (notes) => admitFeed(notes, feed), testChats: (n, m) => { stCache = null; if (m != null) st().communities = Array.from({ length: m }, (_, i) => ({ ...COMMUNITY, community_id: (i + 1).toString(16).padStart(64, 'd'), name: 'Room ' + i })); threads.clear(); for (let i = 0; i < n; i++) { const peer = (i + 1).toString(16).padStart(64, 'c'); threads.set(peer, new Map([['r' + i, { rumor: { id: 'r' + i, kind: 14, pubkey: peer, tags: [], content: 'hi ' + i, created_at: 1700000000 - i }, mine: false }]])); } },")}));
  build.onLoad({filter:/src\/nostr\.js$/},async({path})=>({loader:'js',contents:(await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {','export async function queryOn(relays, filter, maxWait = 1500) { return [];')
    .replace(/export function subscribeOn\(([^)]*)\) \{/,'export function subscribeOn($1) { return () => {};')}));
} }] });
assert(bundle.success,bundle.logs.join('\n'));
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await Bun.file('src/style.css').text()}</style><div id="app"></div><script type="module">${await bundle.outputs[0].text()}</script>`;

const server=Bun.serve({port:0,fetch:()=>new Response(html,{headers:{'content-type':'text/html'}})});
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage(), errors=[];
page.on('pageerror', e=>errors.push(e.message));
await page.setRequestInterception(true);
page.on('request',r=>r.url().startsWith(server.url.origin)?r.continue():r.abort());
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const top=(id)=>page.evaluate((id)=>{const r=document.querySelector('.notes-feed > [data-key="'+id+'"]');return r?Math.round(r.getBoundingClientRect().top):null;},id);
const fresh=()=>page.$$eval('.notes-feed > .row.note-fresh',els=>els.map(e=>e.getAttribute('data-key').slice(0,2)+e.getAttribute('data-key').slice(-1)));
const test_reset=async()=>{await page.evaluate(()=>test.feed());await sleep(300);};
const F=(i)=>'f'+i.toString(16).padStart(63,'0');
try {
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(server.url.href);
  await page.waitForSelector('.note-post',{timeout:5000});
  // At the very top, header showing: new posts go in ABOVE the first post,
  // which stays exactly where it was — the page grows upward (the scrollbar
  // shows it) and the pill says how many, but nothing on screen moves.
  const first='0'.padStart(64,'0');
  await page.evaluate(()=>window.scrollTo(0,0)); await sleep(200);
  const at=await top(first), h0=await page.evaluate(()=>document.documentElement.scrollHeight);
  await page.evaluate(()=>test.arrive(2)); await sleep(400);
  assert(await page.$('.notes-feed > [data-key="'+F(0)+'"]'),'new posts are in the page before any tap');
  assert(Math.abs((await top(first))-at)<=2,'the first post stays put: '+at+' → '+(await top(first)));
  assert(await page.evaluate(()=>scrollY)>0,'the page is scrolled down by what went in above');
  assert(await page.evaluate(()=>document.documentElement.scrollHeight)>h0,'the page grew (the scrollbar shrinks)');
  assert.equal(await page.$eval('.feed-new-pill .n',e=>e.textContent),'2');
  await page.evaluate(()=>window.scrollTo(0,0)); await sleep(300);
  assert(!(await page.$('.feed-new-pill')),'scrolling up to them clears the pill');
  // writing a post up top: arrivals wait behind the pill instead
  await page.evaluate(()=>{test.ui.profCompose='draft';test.render();window.scrollTo(0,0);}); await sleep(200);
  const at2=await top(F(0));
  await page.evaluate(()=>test.feature&&window.test.arriveIds(['e1','e2'])); await sleep(300);
  assert(!(await page.$('.notes-feed > [data-key^="e1"]')),'composer open: the post waits');
  assert.equal(await page.evaluate(()=>scrollY),0,'composer open: nothing moves');
  assert(Math.abs((await top(F(0)))-at2)<=2,'composer open: rows stay');
  await page.evaluate(()=>{test.ui.profCompose=null;test.render();}); await sleep(200);
  await test_reset();
  const reading='6'.padStart(64,'0');
  await page.evaluate((id)=>{const r=document.querySelector('.notes-feed > [data-key="'+id+'"]');window.scrollTo(0,scrollY+r.getBoundingClientRect().top-100);},reading);
  await sleep(300);
  const before=await top(reading);
  await page.evaluate(()=>test.arrive(3)); await sleep(300);
  assert(Math.abs((await top(reading))-before)<=2,'the row being read stays put when posts arrive above');
  assert.equal(await page.$eval('.feed-new-pill .n',e=>e.textContent),'3');
  assert.deepEqual((await fresh()).length,3,'all three new posts wear the tint');
  await page.tap('.feed-new-pill'); await sleep(400);
  const oldest=await top(F(2));
  assert(oldest>=0&&oldest<=20,'pill lands on the oldest new post, not the top: '+oldest);
  assert(await page.evaluate(()=>scrollY)>0,'not scrolled all the way to the top');
  assert(!(await page.$('.feed-new-pill')),'pill is gone after the tap');
  await page.screenshot({path:'/tmp/feed-new-posts.png'});
  await sleep(2600);
  assert(!(await page.$('.notes-feed > .row.note-fresh[data-key="'+F(2)+'"]')),'the post you looked at loses its tint');
  assert(await page.$('.notes-feed > .row.note-fresh[data-key="'+F(0)+'"]'),'the newest, still offscreen above, keeps its tint');
  await page.evaluate(()=>window.scrollTo(0,0)); await sleep(2600);
  assert.deepEqual(await fresh(),[],'back at the top, the rest fade once seen');
  // swipe the pill away: it goes, the page doesn't move, and it's back once more arrive
  await page.evaluate((id)=>{const r=document.querySelector('.notes-feed > [data-key="'+id+'"]');window.scrollTo(0,scrollY+r.getBoundingClientRect().top-100);},reading);
  await sleep(300);
  await page.evaluate(()=>test.arriveIds(['a1','a2'])); await sleep(400);
  const pr=await page.$eval('.feed-new-pill',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,h:r.height};});
  assert(pr.h>=40,'the pill is a thumb-sized target: '+pr.h);
  await page.screenshot({path:'/tmp/feed-pill-big.png'});
  const clash=await page.evaluate(()=>{const a=document.querySelector('.feed-new-pill')?.getBoundingClientRect(),b=document.querySelector('.feed-post-fab')?.getBoundingClientRect();return a&&b&&!(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);});
  assert(!clash,'the pill clears the Post button');
  const y0=await page.evaluate(()=>scrollY);
  await page.mouse.move(pr.x,pr.y); await page.mouse.down();
  for(let i=1;i<=8;i++){await page.mouse.move(pr.x+i*18,pr.y+2); await sleep(16);}
  await page.mouse.up(); await sleep(500);
  assert(!(await page.$('.feed-new-pill')),'a sideways swipe sends the pill away');
  assert.equal(await page.evaluate(()=>scrollY),y0,'and does not jump to the new posts');
  await page.evaluate(()=>test.arriveIds(['b1'])); await sleep(400);
  assert(await page.$('.feed-new-pill'),'more posts bring it back');
  // a short drag springs back and stays
  const pr2=await page.$eval('.feed-new-pill',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  const y1=await page.evaluate(()=>scrollY);
  await page.mouse.move(pr2.x,pr2.y); await page.mouse.down(); await page.mouse.move(pr2.x+20,pr2.y); await page.mouse.up(); await sleep(400);
  assert(await page.$('.feed-new-pill'),'a short drag leaves it');
  assert.equal(await page.evaluate(()=>scrollY),y1,'and is not a tap');
  assert.equal(await page.$eval('.feed-new-pill',e=>e.style.transform),'','sprung back into place');
  assert.deepEqual(errors,[]);
  console.log('✓ New posts: pill lands on the oldest new post; tints stay until each post has been in view ~2s; the reading row stays put; swiping the pill dismisses it until more arrive');
} finally { await page.close(); await browser.close(); server.stop(true); }
