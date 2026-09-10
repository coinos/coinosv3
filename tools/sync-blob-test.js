// Oversized sync domains on Blossom: the envelope, the server's policy, the
// outbox's upload-then-publish flow, and a fresh device resolving a pointer.
// Spawns blossom/server.js on a free port. Run: bun tools/sync-blob-test.js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SyncOutbox } from '../src/sync-outbox.js';
import { NostrSync } from '../src/nostr.js';
import { installSyncWallet } from '../src/features/sync.js';
import { mergeArkStates } from '../src/features/ark.js';
import {
  sealBlob, openBlob, sha256Hex, blobAuth, authHeader, uploadBlob, deleteBlob, fetchBlob, setBlossomConfig, blossomServers,
} from '../src/sync-blob.js';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
globalThis.localStorage = new Storage();
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const signer = (passphrase = '') => { const n = new NostrSync(); n.load(mnemonic, passphrase); return n; };
const a = signer(), b = signer('someone else');

// ---- the server ------------------------------------------------------------
const port = 20000 + Math.floor(Math.random() * 10000);
const dataDir = mkdtempSync(join(tmpdir(), 'blossom-test-'));
const server = Bun.spawn(['bun', new URL('../blossom/server.js', import.meta.url).pathname], {
  env: { ...process.env, BLOSSOM_DATA: dataDir, BLOSSOM_PORT: String(port), BLOSSOM_HOST: 'localhost', BLOSSOM_QUOTA_COUNT: '2', BLOSSOM_MAX_BLOB: String(200_000) },
  stdout: 'ignore', stderr: 'inherit',
});
const base = `http://localhost:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} await Bun.sleep(100); }
const cleanupServer = () => { try { server.kill(); } catch {} rmSync(dataDir, { recursive: true, force: true }); };
process.on('exit', cleanupServer);

try {
  // ---- envelope -------------------------------------------------------------
  const big = { netName: 'mainnet', savedAt: 1, arkState: { vtxos: Array.from({ length: 400 }, (_, i) => ({ id: 'v' + i, amountSat: i, state: 'spendable', bytes: 'ab'.repeat(80) })) } };
  const text = JSON.stringify(big);
  assert.ok(text.length > 40000, 'fixture must exceed the relay budget');
  const sealed = sealBlob(a.ck, text);
  assert.equal(new TextDecoder().decode(sealed.subarray(0, 4)), 'CSB1');
  assert.equal(openBlob(a.ck, sealed), text);
  assert.throws(() => openBlob(b.ck, sealed), 'another wallet cannot open it');
  assert.throws(() => openBlob(a.ck, new Uint8Array(sealed.length)), 'no magic, no envelope');
  assert.ok(!sealed.includes || !new TextDecoder().decode(sealed).includes('spendable'));
  console.log('✓ envelope seals to the wallet self-key and refuses other keys');

  // ---- server policy ----------------------------------------------------------
  const sha = sha256Hex(sealed);
  let r = await fetch(base + '/upload', { method: 'PUT', body: sealed });
  assert.equal(r.status, 401, 'no auth, no upload');
  r = await fetch(base + '/upload', { method: 'PUT', body: sealed, headers: { Authorization: authHeader(blobAuth(a.sk, 'delete', [sha])) } });
  assert.equal(r.status, 401, 'wrong verb');
  r = await fetch(base + '/upload', { method: 'PUT', body: sealed, headers: { Authorization: authHeader(blobAuth(a.sk, 'upload', ['0'.repeat(64)])) } });
  assert.equal(r.status, 401, 'auth must name the blob');
  const pngish = new Uint8Array(5000); pngish.set([0x89, 0x50, 0x4e, 0x47]);
  r = await fetch(base + '/upload', { method: 'PUT', body: pngish, headers: { Authorization: authHeader(blobAuth(a.sk, 'upload', [sha256Hex(pngish)])) } });
  assert.equal(r.status, 415, 'an image is refused even with valid auth');
  r = await fetch(base + '/upload', { method: 'PUT', body: sealed, headers: { Authorization: authHeader(blobAuth(a.sk, 'upload', [sha])), 'Content-Type': 'image/png' } });
  assert.equal(r.status, 415, 'a media content-type is refused');
  r = await fetch(base + '/upload', { method: 'HEAD', headers: { Authorization: authHeader(blobAuth(a.sk, 'upload', [sha])), 'X-SHA-256': sha, 'X-Content-Length': String(sealed.length), 'X-Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200, 'BUD-06 requirements check');
  assert.equal(await uploadBlob(base, sealed, blobAuth(a.sk, 'upload', [sha])), true);
  r = await fetch(`${base}/${sha}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
  assert.equal(sha256Hex(new Uint8Array(await r.arrayBuffer())), sha);
  const got = await fetchBlob(['http://localhost:1', base], sha);
  assert.equal(openBlob(a.ck, got), text, 'fetch skips a dead server and verifies the hash');
  r = await fetch(`${base}/list/${a.pk}`);
  assert.equal(r.status, 401, 'listing needs auth');
  r = await fetch(`${base}/list/${a.pk}`, { headers: { Authorization: authHeader(blobAuth(b.sk, 'list')) } });
  assert.equal(r.status, 403, 'only the owner lists their blobs');
  r = await fetch(`${base}/list/${a.pk}`, { headers: { Authorization: authHeader(blobAuth(a.sk, 'list')) } });
  assert.deepEqual((await r.json()).map((d) => d.sha256), [sha]);
  assert.equal(await deleteBlob(base, sha, blobAuth(b.sk, 'delete', [sha])), false, 'not yours to delete');
  assert.equal((await fetch(`${base}/${sha}`)).status, 200);
  console.log('✓ server stores only signed sync envelopes and serves them as opaque attachments');

  // quota: the third blob evicts the oldest
  const shas = [];
  for (let i = 0; i < 3; i++) {
    const bytes = sealBlob(a.ck, text + i); const h = sha256Hex(bytes); shas.push(h);
    assert.equal(await uploadBlob(base, bytes, blobAuth(a.sk, 'upload', [h])), true);
  }
  assert.equal((await fetch(`${base}/${sha}`)).status, 404, 'oldest evicted under the per-key count quota');
  assert.equal((await fetch(`${base}/${shas[2]}`)).status, 200);
  assert.equal(await deleteBlob(base, shas[2], blobAuth(a.sk, 'delete', [shas[2]])), true);
  assert.equal((await fetch(`${base}/${shas[2]}`)).status, 404);
  console.log('✓ per-key quota evicts oldest; owner delete works');

  // ---- outbox: upload before publish, cleanup after ---------------------------
  setBlossomConfig({ servers: [base], manual: true });
  assert.deepEqual(blossomServers(), [base]);
  const storage = new Storage();
  let now = 1788758000000;
  const sent = [];
  const deps = { storage, now: () => now, schedule: () => 0, cancel: () => {}, warn: () => {},
    send: async (e) => { sent.push(e); return true; }, upload: uploadBlob, remove: deleteBlob };
  const dead = new SyncOutbox({ ...deps, upload: async () => false });
  const bytes1 = sealBlob(a.ck, text); const h1 = sha256Hex(bytes1);
  const enqueueBlob = (box, bytes, h, savedAt) => box.enqueue({
    pubkey: a.pk, dtag: 'bitcoin-wallet:x:test:ark', digest: createHash('sha256').update(String(savedAt)).digest('hex'), relays: ['wss://test.invalid'],
    blob: { sha256: h, size: bytes.length, data: Buffer.from(bytes).toString('base64'), servers: [base], auth: blobAuth(a.sk, 'upload', [h]), deleteAuthFor: (old) => blobAuth(a.sk, 'delete', [old]) },
    sign: (ts) => a.stateEvent({ netName: 'mainnet', savedAt, blob: { v: 1, sha256: h, size: bytes.length, servers: [base] } }, 'bitcoin-wallet:x:test:ark', ts),
  });
  enqueueBlob(dead, bytes1, h1, 1);
  await dead.flush();
  assert.equal(sent.length, 0, 'pointer is not published while the blob has no home');
  assert.equal(dead.records()[0].acknowledged, false);
  const live = new SyncOutbox(deps);
  await live.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(live.records()[0].uploaded, [base]);
  assert.equal(live.records()[0].acknowledged, true);
  assert.equal((await fetch(`${base}/${h1}`)).status, 200);
  assert.equal(sha256Hex(live.localBlob(h1)), h1, 'local recovery copy');
  const raw = [...storage.data.values()].join('');
  assert.ok(!raw.includes('spendable') && !raw.includes(mnemonic), 'storage holds only sealed bytes');
  // a newer blob: the old one is deleted from its server after the new one is acknowledged
  now += 2000;
  const bytes2 = sealBlob(a.ck, text + '2'); const h2 = sha256Hex(bytes2);
  enqueueBlob(live, bytes2, h2, 2);
  assert.equal(live.records()[0].cleanup.length, 1);
  await live.flush();
  assert.equal(sent.length, 2);
  assert.equal((await fetch(`${base}/${h2}`)).status, 200);
  assert.equal((await fetch(`${base}/${h1}`)).status, 404, 'superseded blob removed');
  assert.equal(live.records()[0].cleanup.length, 0);
  console.log('✓ outbox uploads before publishing, keeps a local copy, cleans up superseded blobs');

  // ---- feature: oversized domain becomes a pointer; a fresh device resolves it ----
  function walletStub() {
    const hooks = { saved: [], realtime: [] };
    return {
      hooks, mnemonic, offline: false, netName: 'mainnet', _savedAt: now, txs: [], _cacheExtensions: [],
      registerCacheSavedHook: (fn) => hooks.saved.push(fn), registerLoadHook: () => {}, registerRealtimeHook: (h) => hooks.realtime.push(h),
      saveCache: () => {}, emit: () => {}, _sortTxs: () => {},
      _mergeSnapshotExtensions(s) { if (s.arkState) this.arkState = mergeArkStates(this.arkState, s.arkState); },
      _applySnapshot: () => {},
    };
  }
  const fStorage = new Storage();
  const fBox = new SyncOutbox({ ...deps, storage: fStorage });
  const w = walletStub();
  installSyncWallet(w, { outbox: fBox });
  w.nostr.load(mnemonic);
  w._cacheExtensions = [{ domain: 'ark', save: () => ({ arkState: big.arkState, arkServer: 'asp' }) }];
  w.hooks.saved[0]({ netName: 'mainnet', savedAt: now, txs: [], utxos: [] });
  const evs = fBox.events(a.pk);
  const ptr = a.decodeStateEvents(evs).find((s) => s.dtag.endsWith(':ark'));
  assert.ok(ptr.state.blob && ptr.state.blob.sha256, 'ark domain publishes as a pointer');
  assert.ok(!ptr.state.arkState, 'no plaintext domain in the event');
  const core = a.decodeStateEvents(evs).find((s) => s.dtag.endsWith(':core'));
  assert.ok(!core.state.blob, 'small domains stay inline');
  await fBox.flush();
  assert.equal((await fetch(`${base}/${ptr.state.blob.sha256}`)).status, 200);
  // a fresh device with an empty outbox: only the relay's pointer event to go on
  const fresh = walletStub();
  installSyncWallet(fresh, { outbox: new SyncOutbox({ ...deps, storage: new Storage() }) });
  fresh.nostr.load(mnemonic);
  fresh.nostr.fetchAllStates = async () => a.decodeStateEvents(evs);
  assert.equal(await fresh.syncFromNostr(), true);
  assert.equal(fresh.arkState.vtxos.length, 400, 'pointer resolved from the server and merged');
  // an unreachable server: the pointer is skipped, nothing breaks
  const cut = walletStub();
  installSyncWallet(cut, { outbox: new SyncOutbox({ ...deps, storage: new Storage() }) });
  cut.nostr.load(mnemonic);
  const withDeadServer = a.decodeStateEvents(evs).map((s) => s.state.blob ? { ...s, state: { ...s.state, blob: { ...s.state.blob, servers: ['http://localhost:1'] } } } : s);
  setBlossomConfig({ servers: ['http://localhost:1'], manual: true });
  cut.nostr.fetchAllStates = async () => withDeadServer;
  assert.equal(await cut.syncFromNostr(), true);
  assert.equal(cut.arkState, undefined, 'unresolvable pointer is dropped, not applied');
  console.log('✓ feature routes oversized domains through Blossom; fresh devices resolve pointers');

  console.log('\n✅ blossom sync behaves');
} finally {
  cleanupServer();
}
