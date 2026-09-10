// Ark state store: memory-fronted IndexedDB (a memory backend here) with
// localStorage migration by _rev, raw bytes on disk, clone-on-read,
// write-behind flush, wipe by prefix, and the localStorage fallback.
// Run: bun tools/ark-store-test.js
import assert from 'node:assert/strict';
import { ArkStore, memoryBackend } from '../src/ark/store.js';
import { vtxoBytesToStr } from '../src/ark/proto.js';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
const raw = new Uint8Array(64).map((_, i) => i * 3);
const b64 = vtxoBytesToStr(raw);
const K = 'btc-wallet-cache:abc123:ark:fsobdp';
const HOLD = 'btc-wallet-cache:abc123:ark:pk:03ff959f88f41d5f';
const OTHER = 'btc-wallet-cache:zzz999:ark:fsobdp';

// ---- migration: newest _rev wins, localStorage retired after the write ----
const ls = new Storage();
ls.setItem(K, JSON.stringify({ _rev: 7, vtxos: [{ id: 'a', state: 'spendable', bytes: b64 }], actions: [], movements: [] }));
ls.setItem(HOLD, JSON.stringify({ vtxos: [{ id: 'h', state: 'spendable', bytes: b64 }] }));
ls.setItem('btc-wallet-cache:abc123', '{"txs":[]}'); // the wallet cache is not ours
const backend = memoryBackend([[K, { _rev: 5, vtxos: [{ id: 'a', state: 'spendable', bytes: raw }], actions: [], movements: [] }],
  [OTHER, { _rev: 1, vtxos: [], actions: [], movements: [] }]]);
const store = new ArkStore({ backend, ls: () => ls });
assert.equal(store.ready, false);
await store.open();
assert.equal(store.get(K)._rev, 7, 'the newer localStorage copy wins');
assert.equal(store.get(HOLD).vtxos[0].bytes, b64, 'hold state migrates too');
await store.flush();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ls.getItem(K), null, 'localStorage copy retired after the write');
assert.equal(ls.getItem(HOLD), null);
assert.equal(ls.getItem('btc-wallet-cache:abc123'), '{"txs":[]}', 'unrelated keys untouched');
assert.ok(backend.dump().get(K).vtxos[0].bytes instanceof Uint8Array, 'bytes are raw on disk');
assert.equal(store.get(K).vtxos[0].bytes, b64, 'and base64 strings in memory');
console.log('✓ localStorage state migrates by _rev, bytes land raw, old copies retired');

// ---- reads are clones; writes are write-behind ----
const got = store.get(K); got.vtxos.push({ id: 'evil' });
assert.equal(store.get(K).vtxos.length, 1, 'a caller cannot mutate the store through a read');
const writes = backend.writes;
store.set(K, { _rev: 8, vtxos: [{ id: 'a', state: 'spent', bytes: b64 }, { id: 'b', state: 'spendable', bytes: b64 }], actions: [], movements: [] });
assert.equal(store.get(K)._rev, 8, 'memory is current immediately');
assert.equal(backend.writes, writes, 'disk write is deferred');
await store.flush();
assert.equal(backend.dump().get(K)._rev, 8);
assert.equal(backend.dump().get(K).vtxos.length, 2);
store.remove(OTHER);
await store.flush();
assert.equal(backend.dump().has(OTHER), false);
console.log('✓ clone-on-read, coalesced write-behind, delete');

// ---- a fresh open reads back what was written ----
const again = new ArkStore({ backend, ls: () => new Storage() });
await again.open();
assert.equal(again.get(K).vtxos[1].bytes, b64, 'round trip through raw bytes');
assert.deepEqual(again.keys('btc-wallet-cache:abc123').sort(), [K, HOLD].sort(), 'keys by prefix');
console.log('✓ reopen restores state');

// ---- wipe by wallet prefix (both stores) ----
const ls2 = new Storage(); ls2.setItem('btc-wallet-cache:abc123:ark', '{"vtxos":[]}');
const wipe = new ArkStore({ backend, ls: () => ls2 });
await wipe.open(); await wipe.flush();
wipe.removePrefix('btc-wallet-cache:abc123');
await wipe.flush();
assert.equal(wipe.keys('btc-wallet-cache:abc123').length, 0);
assert.equal(backend.dump().has(K), false);
assert.equal(ls2.getItem('btc-wallet-cache:abc123:ark'), null);
console.log('✓ wallet wipe clears IndexedDB and localStorage copies');

// ---- no IndexedDB: localStorage exactly as before ----
const ls3 = new Storage();
const fallback = new ArkStore({ backend: null, ls: () => ls3 });
assert.equal(fallback.ready, true);
fallback.set(K, { _rev: 1, vtxos: [] });
assert.equal(JSON.parse(ls3.getItem(K))._rev, 1);
assert.equal(fallback.get(K)._rev, 1);
const broken = new ArkStore({ backend: { list: async () => { throw new Error('nope'); }, write: async () => {} }, ls: () => ls3 });
await broken.open();
assert.equal(broken.lsMode, true, 'a refusing IndexedDB drops to localStorage');
assert.equal(broken.get(K)._rev, 1);
console.log('✓ localStorage fallback');

console.log('\n✅ ark store behaves');
