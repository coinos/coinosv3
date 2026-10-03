// White Noise interop: src/marmot.js + src/mls.js against the Rust reference
// (MDK's `wn` CLI + `wnd` daemon) over a local relay.
//
//   bun run tools/marmot-interop-test.js
//
// Needs, and skips cleanly without:
//   - a relay on RELAY (default ws://127.0.0.1:27777; the MDK repo's
//     `just relay-up`, or any strfry)
//   - `wn` on PATH built from github.com/marmot-protocol/mdk
//     (cargo install --path crates/cli --locked --bins), with a daemon running:
//       export WN_HOME=… WN_SECRET_STORE=file WN_ALLOW_LOOPBACK_RELAYS=1
//       wn daemon start --discovery-relays $RELAY --default-account-relays $RELAY
//
// Covers both directions: wn invites us (Welcome → join → messages → our
// self-update commit), and we found a group, invite wn accounts, rename,
// add and remove members, and commit a wn member's SelfRemove.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { wrapDM, unwrapDM } from '../src/dm.js';
import * as M from '../src/marmot.js';

const RELAY = process.env.RELAY || 'ws://127.0.0.1:27777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label);
  else { failed++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

function wn(args, { account, input } = {}) {
  const r = spawnSync('wn', ['--json', ...(account ? ['--account', account] : []), ...args], { encoding: 'utf8', input });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1) || '';
  try {
    const j = JSON.parse(line);
    if (!j.ok) return { error: j.error, raw: line };
    return j.result;
  } catch { return { error: { message: (r.stderr || r.stdout || 'no output').trim() } }; }
}

// ---- a tiny relay client ----
let ws, subs = new Map(), acks = new Map(), sid = 0;
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(RELAY);
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('no relay at ' + RELAY));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d[0] === 'EVENT') subs.get(d[1])?.events.push(d[2]);
      else if (d[0] === 'EOSE') subs.get(d[1])?.done();
      else if (d[0] === 'OK') acks.get(d[1])?.(d[2] ? null : new Error(d[3] || 'rejected'));
    };
  });
}
function query(filter) {
  return new Promise((resolve) => {
    const id = 'q' + ++sid, events = [];
    const done = () => { subs.delete(id); ws.send(JSON.stringify(['CLOSE', id])); resolve(events); };
    subs.set(id, { events, done });
    ws.send(JSON.stringify(['REQ', id, filter]));
    setTimeout(done, 3000);
  });
}
function publish(ev) {
  return new Promise((resolve, reject) => {
    acks.set(ev.id, (err) => { acks.delete(ev.id); err ? reject(err) : resolve(true); });
    ws.send(JSON.stringify(['EVENT', ev]));
    setTimeout(() => reject(new Error('publish timed out')), 4000);
  });
}

// ---- our side: one account, one device ----
const sk = generateSecretKey(), pk = getPublicKey(sk);
const sign = async (e) => finalizeEvent(e, sk);
const now = () => Math.floor(Date.now() / 1000);
let device, kps = [];

async function publishKeyPackage() {
  const kp = M.newKeyPackage(device);
  const ev = await sign(M.keyPackageEvent(device, kp));
  await publish(ev);
  kps.push({ ...kp, eventId: ev.id });
  return ev;
}

const seenWraps = new Set();
async function welcomes() {
  const out = [];
  for (const wrap of await query({ kinds: [1059], '#p': [pk] })) {
    if (seenWraps.has(wrap.id)) continue;
    seenWraps.add(wrap.id);
    const got = await unwrapDM(wrap, sk);
    if (got && got.rumor.kind === 444) out.push(got.rumor);
  }
  return out;
}

// pull everything on the group's routing addresses through the engine
async function sync(g) {
  const out = [];
  for (const r of M.routes(g)) {
    const evs = (await query({ kinds: [445], '#h': [r.id] })).sort((a, b) => a.created_at - b.created_at);
    for (const ev of evs) out.push(...M.receive(g, ev));
  }
  if (process.env.DEBUG) for (const o of out) if (!o.id) console.log('   ·', JSON.stringify(o), 'epoch', g.tip.epoch, 'held', g.held.length);
  return out;
}
const texts = (g) => g.log.filter((m) => m.kind === 9).map((m) => m.content);

async function commit(g, proposals) {
  const p = M.stage(g, { proposals });
  await publish(p.ev);
  M.confirm(g);
  return p;
}

async function waitFor(fn, label, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) { ok(false, label, 'timed out'); return null; }
    await sleep(700);
  }
}

// BUD-02 upload with a kind-24242 auth, as the app does it
async function upload(cipher, x) {
  const at = now();
  const auth = finalizeEvent({ kind: 24242, created_at: at - 5, content: 'upload', tags: [['t', 'upload'], ['x', x], ['expiration', String(at + 600)]] }, sk);
  for (const server of M.MEDIA_ENDPOINTS) {
    try {
      const r = await fetch(server + 'upload', { method: 'PUT', body: cipher, headers: { authorization: 'Nostr ' + btoa(JSON.stringify(auth)), 'content-type': 'application/octet-stream' } });
      if (r.ok) return (await r.json()).url;
    } catch {}
  }
  throw new Error('no blossom host took the blob');
}
async function fetchBlob(urls) {
  for (const u of urls) { try { const r = await fetch(u); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch {} }
  return null;
}
// a small real PNG, so every app treats it as a picture
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

async function main() {
  try { await connect(); } catch (e) { console.log('SKIP: ' + e.message); return; }
  const who = wn(['whoami']);
  if (who.error) { console.log('SKIP: wn daemon not reachable (' + who.error.message + ')'); return; }

  const mk = () => { const r = wn(['create-identity']); if (r.error) throw new Error('create-identity: ' + JSON.stringify(r.error)); return r.account_id; };
  const alice = mk(), bob = mk();
  console.log('wn accounts', alice.slice(0, 8), bob.slice(0, 8), '· us', pk.slice(0, 8));

  // an account other clients can find: relay lists + a KeyPackage
  await publish(await sign({ kind: 10002, created_at: now(), tags: [['r', RELAY]], content: '' }));
  await publish(await sign({ kind: 10050, created_at: now(), tags: [['relay', RELAY]], content: '' }));
  device = await M.newDevice(sign, pk);
  const kpEv = await publishKeyPackage();
  ok(!!M.readKeyPackageEvent(kpEv), 'our KeyPackage event validates locally');

  console.log('\n1. wn reads our KeyPackage');
  const check = wn(['keys', 'check', pk]);
  ok(!check.error && JSON.stringify(check).includes('true'), 'wn keys check accepts it', JSON.stringify(check).slice(0, 300));

  console.log('\n2. wn founds a group and invites us');
  const made = wn(['groups', 'create', 'interop', pk], { account: alice });
  ok(!made.error, 'wn groups create', JSON.stringify(made.error || ''));
  const wnGroup = made.group_id || made.group?.group_id || made.group_id_hex;
  const rumor = await waitFor(async () => (await welcomes())[0], 'Welcome arrives');
  if (!rumor) return;
  let g;
  try {
    const j = M.join(device, rumor, kps);
    g = j.g;
    ok(true, 'joined from wn Welcome (epoch ' + g.tip.epoch + ', ' + M.accounts(g.tip).length + ' accounts)');
    ok(M.groupView(g.tip).name === 'interop', 'group name reads back', M.groupView(g.tip).name);
    ok(g.inviter === alice, 'inviter is the wn account');
  } catch (e) { ok(false, 'join from wn Welcome', e.stack); return; }
  await publishKeyPackage(); // rotate the consumed package

  console.log('\n3. messages both ways');
  wn(['messages', 'send', wnGroup, 'hello from wn'], { account: alice });
  await waitFor(async () => { await sync(g); return texts(g).includes('hello from wn'); }, 'wn → us application message');
  ok(texts(g).includes('hello from wn'), 'we decrypt wn\'s message');
  await publish(M.send(g, M.appEvent(pk, 9, 'hello from js')));
  const seen = await waitFor(async () => JSON.stringify(wn(['messages', 'list', wnGroup, '--limit', '20'], { account: alice })).includes('hello from js'), 'us → wn application message');
  ok(!!seen, 'wn decrypts our message');

  console.log('\n3b. pictures both ways (encrypted-media-v2)');
  {
    const dir = mkdtempSync(join(tmpdir(), 'wn-media-'));
    const file = join(dir, 'from-wn.png');
    const body = new Uint8Array([...PNG, ...randomBytes(8)]); // unique bytes per run
    writeFileSync(file, body);
    const up = wn(['media', 'upload', wnGroup, file, '--send'], { account: alice });
    ok(!up.error, 'wn uploads and sends a picture', JSON.stringify(up.error || ''));
    const got = await waitFor(async () => { await sync(g); return g.log.find((m) => m.tags.some((t) => t[0] === 'imeta')); }, 'picture message arrives');
    if (got) {
      const ref = got.tags.map(M.readMediaTag).filter(Boolean)[0];
      ok(!!ref, 'its imeta tag reads as encrypted-media-v2', JSON.stringify(got.tags).slice(0, 300));
      const blob = ref && await fetchBlob(ref.urls);
      ok(!!blob, 'the blob is fetchable from its locator');
      let plain = null;
      try { plain = M.openMedia(M.mediaSecretAt(g, got.epoch), blob, ref.ref); } catch (e) { ok(false, 'decrypt', e.message); }
      ok(plain && bytesToHex(plain) === bytesToHex(body), 'we decrypt wn\'s picture to the original bytes');
    }
    // ours to wn
    const mine = new Uint8Array([...PNG, ...randomBytes(8)]);
    const sealed = M.sealMedia(M.mediaSecret(g.tip), mine, { type: 'image/png', name: 'from-js.png' });
    const url = await upload(sealed.cipher, sealed.ref.cipher);
    await publish(M.send(g, M.appEvent(pk, 9, 'a picture', [M.mediaTag(sealed.ref, [url], '2x2')])));
    const listed = await waitFor(async () => JSON.stringify(wn(['media', 'list', wnGroup], { account: alice })).includes(sealed.ref.plain), 'wn lists our picture');
    if (listed) {
      const out = mkdtempSync(join(tmpdir(), 'wn-dl-'));
      const dl = wn(['media', 'download', wnGroup, sealed.ref.plain, '--output', out], { account: alice });
      ok(!dl.error, 'wn downloads our picture', JSON.stringify(dl.error || ''));
      const f = readdirSync(out)[0];
      ok(f && bytesToHex(readFileSync(join(out, f))) === bytesToHex(mine), 'wn decrypts it to the original bytes');
    }
  }

  console.log('\n4. our self-update commit, then traffic in the new epoch');
  const e0 = g.tip.epoch;
  await commit(g, []);
  ok(g.tip.epoch === e0 + 1, 'self-update applied locally');
  await sleep(1500);
  wn(['messages', 'send', wnGroup, 'after your update'], { account: alice });
  await waitFor(async () => { await sync(g); return texts(g).includes('after your update'); }, 'wn follows our commit');
  ok(texts(g).includes('after your update'), 'wn accepted our commit (message in the new epoch decrypts)');

  console.log('\n5. wn changes the group; we follow');
  wn(['groups', 'rename', wnGroup, 'interop-renamed'], { account: alice });
  await waitFor(async () => { await sync(g); return M.groupView(g.tip).name === 'interop-renamed'; }, 'rename commit from wn');
  ok(M.groupView(g.tip).name === 'interop-renamed', 'we process wn\'s AppDataUpdate commit');
  wn(['groups', 'add-members', wnGroup, bob], { account: alice });
  await waitFor(async () => { await sync(g); return M.accounts(g.tip).includes(bob); }, 'add commit from wn');
  ok(M.accounts(g.tip).includes(bob), 'we process wn\'s Add commit');
  await publish(M.send(g, M.appEvent(pk, 9, 'welcome bob')));
  ok(!!await waitFor(async () => JSON.stringify(wn(['messages', 'list', wnGroup, '--limit', '20'], { account: bob })).includes('welcome bob'), 'bob reads us'), 'a member wn added reads our message');

  console.log('\n6. we found a group and invite a wn account');
  const fetchKp = async (who) => M.pickKeyPackage((await query({ kinds: [30443], authors: [who] })).map((e) => M.readKeyPackageEvent(e)).filter(Boolean));
  const aliceKp = await fetchKp(alice);
  ok(!!aliceKp, 'wn KeyPackage validates in JS');
  if (!aliceKp) return;
  const f = M.found(device, { name: 'from-js', relays: [RELAY], invitees: [aliceKp] });
  const mine = f.g;
  await publish(await wrapDM(sk, alice, M.welcomeRumor(pk, f.welcome, aliceKp.id, [RELAY])));
  const mineId = mine.id;
  const listed = await waitFor(async () => JSON.stringify(wn(['chats', 'list'], { account: alice })).includes(mineId) || JSON.stringify(wn(['groups', 'invites'], { account: alice })).includes(mineId), 'wn joins our group');
  ok(!!listed, 'wn processes our Welcome');
  wn(['groups', 'accept', mineId], { account: alice });
  await publish(M.send(mine, M.appEvent(pk, 9, 'first post')));
  ok(!!await waitFor(async () => JSON.stringify(wn(['messages', 'list', mineId, '--limit', '20'], { account: alice })).includes('first post'), 'wn reads our group'), 'wn decrypts a message in our group');
  wn(['messages', 'send', mineId, 'reply from wn'], { account: alice });
  await waitFor(async () => { await sync(mine); return texts(mine).includes('reply from wn'); }, 'wn → our group');
  ok(texts(mine).includes('reply from wn'), 'we decrypt wn in our group');
  {
    // our group carries our media policy: wn must accept it and upload where it says
    const dir = mkdtempSync(join(tmpdir(), 'wn-media-'));
    const file = join(dir, 'into-ours.png');
    const body = new Uint8Array([...PNG, ...randomBytes(8)]);
    writeFileSync(file, body);
    const up = wn(['media', 'upload', mineId, file, '--send'], { account: alice });
    ok(!up.error, 'wn sends a picture into our group (our endpoints)', JSON.stringify(up.error || ''));
    const got = await waitFor(async () => { await sync(mine); return mine.log.find((m) => m.tags.some((t) => t[0] === 'imeta')); }, 'picture in our group');
    const ref = got && got.tags.map(M.readMediaTag).filter(Boolean)[0];
    const blob = ref && await fetchBlob(ref.urls);
    let plain = null;
    try { plain = blob && M.openMedia(M.mediaSecretAt(mine, got.epoch), blob, ref.ref); } catch {}
    ok(plain && bytesToHex(plain) === bytesToHex(body), 'and we decrypt it', ref ? ref.urls.join(' ') : '');
  }

  console.log('\n7. our commits in our group: add, rename, remove');
  const bobKp = await fetchKp(bob);
  const add = await commit(mine, M.invite([bobKp]));
  await publish(await wrapDM(sk, bob, M.welcomeRumor(pk, add.welcome, bobKp.id, [RELAY])));
  ok(!!await waitFor(async () => JSON.stringify(wn(['chats', 'list'], { account: bob })).includes(mineId) || JSON.stringify(wn(['groups', 'invites'], { account: bob })).includes(mineId), 'bob joins'), 'wn joins from our Add commit\'s Welcome');
  wn(['groups', 'accept', mineId], { account: bob });
  await commit(mine, [M.setProfile('renamed-by-js')]);
  ok(!!await waitFor(async () => JSON.stringify(wn(['groups', 'show', mineId], { account: alice })).includes('renamed-by-js'), 'wn sees rename'), 'wn processes our AppDataUpdate commit');
  wn(['messages', 'send', mineId, 'bob here'], { account: bob });
  await waitFor(async () => { await sync(mine); return texts(mine).includes('bob here'); }, 'bob → us');
  ok(texts(mine).includes('bob here'), 'three-member traffic after our commits');

  console.log('\n8. a wn member leaves (SelfRemove); we commit it');
  const left = wn(['groups', 'leave', mineId], { account: bob });
  ok(!left.error, 'wn groups leave', JSON.stringify(left.error || ''));
  const asked = await waitFor(async () => (await sync(mine)).find((o) => o.selfRemove !== undefined) || (mine.tip.pending || []).length > 0, 'SelfRemove proposal arrives');
  if (asked) {
    await commit(mine, []);
    ok(!M.accounts(mine.tip).includes(bob), 'bob is out after our SelfRemove commit');
    wn(['messages', 'send', mineId, 'two again'], { account: alice });
    await waitFor(async () => { await sync(mine); return texts(mine).includes('two again'); }, 'alice follows the SelfRemove commit');
    ok(texts(mine).includes('two again'), 'wn accepted our SelfRemove commit');
  }

  console.log('\n9. we remove a member');
  await commit(mine, M.remove(mine, alice));
  ok(M.accounts(mine.tip).length === 1, 'alice removed locally');
  ok(!!await waitFor(async () => { const s = JSON.stringify(wn(['chats', 'list', '--include-archived'], { account: alice })); return /removed|left|inactive/i.test(s) || !s.includes(mineId); }, 'wn notices removal', 12000), 'wn realizes its removal');
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
