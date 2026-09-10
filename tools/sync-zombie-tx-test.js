// The cross-device history union must not resurrect a stale pending tx from
// another device's snapshot (a never-broadcast/replaced tx that the local
// scan already pruned). Run: bun tools/sync-zombie-tx-test.js
import assert from 'node:assert/strict';
import { SyncOutbox } from '../src/sync-outbox.js';
import { installSyncWallet } from '../src/features/sync.js';

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
const now = Date.now();
const wallet = {
  mnemonic, offline: false, netName: 'mainnet', _savedAt: 0, txs: [{ txid: 'mine-confirmed', confirmed: true, blockHeight: 10 }], _cacheExtensions: [],
  registerCacheSavedHook: () => {}, registerLoadHook: () => {}, registerRealtimeHook: () => {},
  saveCache: () => {}, emit: () => {}, _sortTxs: () => {}, _mergeSnapshotExtensions: () => {}, _applySnapshot() {},
};
installSyncWallet(wallet, { outbox: new SyncOutbox({ storage: new Storage(), send: async () => true, schedule: () => 0, cancel: () => {} }) });
wallet.nostr.load(mnemonic);
wallet.nostr.fetchAllStates = async () => [{
  dtag: 'bitcoin-wallet:x:dead-device:core', created_at: 1,
  state: { netName: 'mainnet', savedAt: 1, txs: [
    { txid: 'zombie', confirmed: false, firstSeen: now - 4 * 86400_000, net: -5000 }, // 4 days pending, unknown to the network
    { txid: 'fresh-pending', confirmed: false, firstSeen: now - 60_000, net: -1 },     // a minute old: give it a chance
    { txid: 'old-confirmed', confirmed: true, blockHeight: 5 },
  ] },
}];
assert.equal(await wallet.syncFromNostr(), true);
const ids = wallet.txs.map((t) => t.txid).sort();
assert.deepEqual(ids, ['fresh-pending', 'mine-confirmed', 'old-confirmed']);
console.log('✓ stale pending txs from other devices are not resurrected; confirmed and fresh ones still union');
