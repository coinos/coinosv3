// Snapshot-first Spending restore, without real relays, keys, or payments.
// Run: bun tools/spending-restore-test.js
import assert from 'node:assert/strict';
import { slimArkForSync, mergeArkStates, arkFeature } from '../src/features/ark.js';
import { installSyncWallet } from '../src/features/sync.js';
import { ArkManager } from '../src/ark/manager.js';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
globalThis.localStorage = new Storage();
globalThis.fetch = async () => { throw new Error('Network disabled in restore test'); };
const serverPubkey = '02' + 'ab'.repeat(32);
const empty = () => ({ v: 1, serverPubkey, mailboxCheckpoint: 0, vtxos: [], actions: [], movements: [], scheduled: [] });
const full = {
  ...empty(), mailboxCheckpoint: 123456, nextKeyIndex: 401,
  vtxos: Array.from({ length: 400 }, (_, i) => ({ id: 'coin-' + i, state: 'spent', amountSat: 100, keyIndex: 0 })),
  movements: Array.from({ length: 400 }, (_, i) => ({ id: 'move-' + i, type: 'receive', status: 'complete', vtxoId: 'coin-' + i, amountSat: 100, ts: 1700000000000 + i })),
  actions: Array.from({ length: 120 }, (_, i) => ({ id: 'send-' + i, type: 'send', step: 'done', amountSat: 50, inputIds: ['coin-' + i] })),
};
const snapshot = slimArkForSync(full);
assert.equal(snapshot.movements.length, 400);
assert.equal(snapshot.vtxos.length, 400);
assert.equal(snapshot.actions.length, 120);
assert.deepEqual(slimArkForSync(snapshot).actions[0].inputIds, ['coin-0']);
assert.equal(mergeArkStates(empty(), snapshot).mailboxCheckpoint, 123456);
const local = { ...empty(), mailboxCheckpoint: 10, movements: [{ id: 'local' }] };
assert.equal(mergeArkStates(local, snapshot).mailboxCheckpoint, 10);
assert.equal(mergeArkStates({ ...empty(), actions: [{ id: 'pending', step: 'signing' }] }, snapshot).mailboxCheckpoint, 0);
const older = { ...empty(), vtxos: [{ id: 'coin-0', amountSat: 100, state: 'spendable' }] };
assert.equal(mergeArkStates(snapshot, older).vtxos.find(v => v.id === 'coin-0').state, 'spent');
console.log('✓ complete history, spent stubs and spend provenance survive repeated snapshotting');
console.log('✓ fresh restores inherit the cursor; existing or unfinished local work does not skip messages');

const hooks = { realtime: [], load: [] };
const wallet = {
  offline: false, netName: 'mainnet', txs: [], _savedAt: 0,
  registerCacheSavedHook() {}, registerLoadHook: f => hooks.load.push(f),
  registerRealtimeHook: h => hooks.realtime.push(h),
  _mergeSnapshotExtensions(s) { if (s.arkState) this.arkState = mergeArkStates(this.arkState, s.arkState); },
  _applySnapshot() {}, emit() {}, saveCache() {},
};
installSyncWallet(wallet, { outbox: null });
wallet.nostr.load('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
let fetched = 0, subscribed = 0, finish;
wallet.nostr.fetchAllStates = () => { fetched++; return new Promise(r => { finish = r; }); };
wallet.nostr.subscribeStates = () => { subscribed++; return () => {}; };
hooks.realtime[0].start();
const restore = wallet.syncFromNostr();
assert.equal(fetched, 1);
assert.equal(subscribed, 0);
finish([
  { created_at: 2, dtag: 'bitcoin-wallet:x:one:ark', state: { netName: 'mainnet', arkState: snapshot } },
  { created_at: 1, dtag: 'bitcoin-wallet:x:two:ark', state: { netName: 'mainnet', arkState: older } },
]);
assert.equal(await restore, true);
await Promise.resolve();
assert.equal(subscribed, 1);
assert.equal(wallet.arkState.movements.length, 400);
assert.equal(wallet.arkState.vtxos[0].state, 'spent');
console.log('✓ initial fetch is shared and sorted before live snapshot delivery begins');
hooks.realtime[0].stop();
wallet.nostrRestoreReady = null;
hooks.realtime[0].start();
hooks.realtime[0].stop();
const stopped = wallet.nostrRestoreReady;
finish([]); await stopped; await Promise.resolve();
assert.equal(subscribed, 1);
console.log('✓ logout during restore does not restart the old identity subscription');

// Real Ark feature lifecycle, with only the manager's network operations
// replaced. Exercise the first-login case where state is held until the ASP
// handshake establishes which server owns it.
const original = {};
for (const name of ['init', 'sync', 'startMailboxStream', 'stopMailboxStream']) original[name] = ArkManager.prototype[name];
let syncs = 0, streams = 0, releaseRestore, releaseCatchup, manager;
const restored = new Promise(r => { releaseRestore = r; });
const catchup = new Promise(r => { releaseCatchup = r; });
ArkManager.prototype.init = async function () {
  manager = this;
  this.info = { serverPubkey };
  this.state = this.storage.adopt(serverPubkey) || this.storage.load() || empty();
  return this;
};
ArkManager.prototype.sync = async function () { syncs++; assert.equal(this.state.mailboxCheckpoint, 123456); await catchup; };
ArkManager.prototype.startMailboxStream = function () { streams++; };
ArkManager.prototype.stopMailboxStream = function () {};
let extension;
const arkWallet = {
  _cacheKey: () => 'fresh-spending-test', account: () => ({}),
  registerCacheExtension: e => { extension = e; },
  nostrRestoreReady: restored, saveCache() {}, loadFeatureState: () => ({}),
};
const feature = arkFeature({ wallet: arkWallet, ui: {}, render() {}, hook() {}, getAccount: () => 'spending' });
const pause = () => new Promise(r => setTimeout(r, 20));
try {
  feature.init(); // no local Spending state yet
  extension.load({ arkState: snapshot });
  await pause();
  assert.ok(manager, 'held snapshot starts a connection immediately, without the old 20-second throttle');
  assert.equal(syncs, 0);
  assert.equal(streams, 0);
  assert.equal(manager.state.movements.length, 400);
  releaseRestore(true); await pause();
  assert.equal(syncs, 1);
  assert.equal(streams, 0);
  releaseCatchup(); await pause();
  assert.equal(streams, 1);
  console.log('✓ fresh Spending adopts the whole snapshot before catch-up, then starts its live stream');
} finally {
  feature.stop();
  for (const [name, fn] of Object.entries(original)) ArkManager.prototype[name] = fn;
}
process.exit(0);
