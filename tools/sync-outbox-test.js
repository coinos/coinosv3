// Run: bun tools/sync-outbox-test.js. No live wallet or network required.
import assert from 'node:assert/strict';
import { SyncOutbox } from '../src/sync-outbox.js';
import { NostrSync } from '../src/nostr.js';
import { installSyncWallet } from '../src/features/sync.js';
import { mergeArkStates, adoptArkSnapshot, arkFeature } from '../src/features/ark.js';
import { createHash } from 'node:crypto';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const signer = (passphrase = '') => { const n = new NostrSync(); n.load(mnemonic, passphrase); return n; };
const a = signer(), b = signer('different wallet');
const storage = new Storage();
globalThis.localStorage = storage;
let now = 1788758000000;
let nextTimer = 0;
const timers = new Map();
const scheduled = [];
const deps = {
  storage, now: () => now,
  schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, fn); scheduled.push(delay); return id; },
  cancel: id => timers.delete(id), warn: () => {},
};
const enqueue = (box, n, state, dtag = 'bitcoin-wallet:x:test:ark') => box.enqueue({
  pubkey: n.pk, dtag, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex'), relays: ['wss://test.invalid'],
  sign: ts => n.stateEvent(state, dtag, ts),
});
const balance = state => state.vtxos.filter(v => v.state === 'spendable').reduce((n, v) => n + v.amountSat, 0);
const restored = {
  netName: 'mainnet', savedAt: now, arkServer: 'asp', arkState: {
    vtxos: [{ id: 'deposit', amountSat: 5000, state: 'spent' }, { id: 'change', amountSat: 4499, state: 'spendable', bytes: 'signed-coin' }],
    actions: [], movements: [{ id: 'payment', type: 'ln-send', status: 'complete', amountSat: 501, inputIds: ['deposit'] }], nextKeyIndex: 19,
  },
};

// The exact outage: save a payment, relay refuses it, page dies. A fresh
// outbox retries the same signed event and a new device recovers the change.
const offline = new SyncOutbox({ ...deps, send: async () => false });
enqueue(offline, a, restored);
await offline.flush();
assert.equal(offline.records()[0].acknowledged, false);
assert.ok(scheduled.at(-1) >= 5000);
const received = [];
const restarted = new SyncOutbox({ ...deps, send: async event => { received.push(event); return true; } });
await restarted.flush();
assert.equal(restarted.records()[0].acknowledged, true);
assert.equal(balance(a.decodeStateEvents(received)[0].state.arkState), 4499);
assert.equal(a.decodeStateEvents(received)[0].state.arkState.nextKeyIndex, 19);
console.log('✓ rejected publish survives restart and restores change/history');

// Delivery does not need the live signing key, and never switches to the
// account activated while the relay was offline.
enqueue(restarted, b, { netName: 'mainnet', protected: 'private-nwc-connection' });
const bpk = b.pk;
b.unload();
await restarted.flush();
assert.equal(received.at(-1).pubkey, bpk);
assert.equal(a.decodeStateEvents([received.at(-1)]).length, 0);
const raw = [...storage.data.values()].join('');
assert.ok(!raw.includes('private-nwc-connection') && !raw.includes('signed-coin') && !raw.includes(mnemonic));
console.log('✓ queued snapshots stay encrypted and bound to their original account');

// A relay acceptance for the old event must not erase a newer queued update.
now += 2000;
let release;
const racing = new SyncOutbox({ ...deps, send: () => new Promise(r => { release = r; }) });
enqueue(racing, a, { ...restored, savedAt: now });
const inFlight = racing.flush();
enqueue(racing, a, { ...restored, savedAt: now + 1 });
const latestId = racing.events(a.pk)[0].id;
release(true);
await inFlight;
assert.equal(racing.records().find(r => r.event.id === latestId).acknowledged, false);
assert.ok(racing.events(a.pk)[0].created_at > received[0].created_at);
console.log('✓ late acceptance cannot discard a newer snapshot');

// Changes inside a second coalesce until their timestamp is safe to publish.
const future = racing.events(a.pk)[0].created_at;
enqueue(racing, a, { ...restored, savedAt: now + 2 });
assert.equal(racing.events(a.pk)[0].created_at, future);
let calls = 0;
const timed = new SyncOutbox({ ...deps, send: async () => { calls++; return true; } });
await timed.flush();
assert.equal(calls, 0);
now = future * 1000;
await timed.flush();
assert.equal(calls, 1);
console.log('✓ successive updates obey relay replacement ordering');

// Exercise the actual feature save/restore hooks, including stopping realtime
// immediately after a payment and restoring from a stale deposit-only cache.
function walletStub() {
  const hooks = { saved: [], realtime: [] };
  const wallet = {
    hooks, mnemonic, offline: false, netName: 'mainnet', _savedAt: now,
    txs: [], _cacheExtensions: [],
    registerCacheSavedHook: fn => hooks.saved.push(fn),
    registerLoadHook: () => {}, registerRealtimeHook: h => hooks.realtime.push(h),
    saveCache: () => {}, emit: () => {}, _sortTxs: () => {},
    _mergeSnapshotExtensions(s) { if (s.arkState) this.arkState = mergeArkStates(this.arkState, s.arkState); },
    _applySnapshot: () => {},
  };
  return wallet;
}
const featureStorage = new Storage();
globalThis.localStorage = featureStorage;
const featureBox = new SyncOutbox({ ...deps, storage: featureStorage, send: async () => false });
const wallet = walletStub();
installSyncWallet(wallet, { outbox: featureBox });
wallet.nostr.load(mnemonic);
let liveArk = restored.arkState;
wallet._cacheExtensions = [{ domain: 'ark', save: () => ({ arkState: liveArk, arkServer: 'asp' }) }];
wallet.hooks.saved[0]({ ...restored, txs: [], utxos: [] });
for (const hook of wallet.hooks.realtime) hook.stop?.();
assert.equal(featureBox.events(a.pk).length, 2);
const captured = featureBox.events(a.pk).map(e => e.id);
wallet.hooks.saved[0]({ ...restored, savedAt: now + 50, txs: [], utxos: [] });
assert.deepEqual(featureBox.events(a.pk).map(e => e.id), captured, 'timestamp-only saves must not republish');
liveArk = { vtxos: [{ id: 'foreign-coin', amountSat: 99 }] };
wallet.nostr.load(mnemonic, 'different wallet');
const state = a.decodeStateEvents(featureBox.events(a.pk)).find(s => s.state.arkState).state.arkState;
assert.equal(balance(state), 4499, 'extension state is captured before account switch');
console.log('✓ realtime stop preserves snapshots; account switches cannot mix domains');

const fresh = walletStub();
installSyncWallet(fresh, { outbox: featureBox });
fresh.nostr.load(mnemonic);
fresh.arkState = { vtxos: [{ id: 'deposit', state: 'spendable', amountSat: 5000 }], movements: [], actions: [] };
fresh.nostr.fetchAllStates = async () => [];
assert.equal(await fresh.syncFromNostr(), true);
assert.equal(balance(fresh.arkState), 4499);
assert.equal(fresh.arkState.movements[0].amountSat, 501);
assert.equal(fresh.arkState.nextKeyIndex, 19);
console.log('✓ fresh session merges encrypted local recovery while relay is unavailable');

// Do not apply a fetched snapshot if the user switched accounts during I/O.
let finishFetch;
fresh.nostr.fetchAllStates = () => new Promise(resolve => { finishFetch = resolve; });
const fetching = fresh.syncFromNostr();
fresh.nostr.load(mnemonic, 'different wallet');
finishFetch([{ state: restored, dtag: 'bitcoin-wallet:x:test:ark', created_at: now / 1000 }]);
assert.equal(await fetching, false);
console.log('✓ account switch during fetch rejects the previous wallet result');

// Stored or relayed events must pass signatures as well as decryption.
const corrupt = { ...JSON.parse(JSON.stringify(received[0])), sig: '00'.repeat(64) };
assert.deepEqual(a.decodeStateEvents([corrupt]), []);
console.log('✓ invalid recovery signatures are rejected');

// The receiving manager is already connected when the relay supplies change.
// Update its live balance and history, keeping references held by an awaiting
// payment driver intact. A second identical snapshot must not trigger a loop.
const pendingCoin = { id: 'pending', amountSat: 100, state: 'pending' };
const pendingAction = { id: 'in-flight', type: 'ln-pay', step: 'initiated' };
const managerState = { vtxos: [pendingCoin, { id: 'deposit', state: 'spendable', amountSat: 5000 }], actions: [pendingAction], movements: [] };
let saves = 0;
const mgr = { state: managerState, _save: () => { saves++; } };
assert.equal(adoptArkSnapshot(mgr, restored.arkState), true);
assert.equal(balance(mgr.state), 4499);
assert.equal(mgr.state.movements[0].amountSat, 501);
assert.equal(mgr.state, managerState);
assert.equal(mgr.state.vtxos.find(v => v.id === 'pending'), pendingCoin);
assert.equal(mgr.state.actions[0], pendingAction);
pendingAction.step = 'done';
pendingCoin.state = 'spent';
assert.equal(mgr.state.actions[0].step, 'done');
assert.equal(mgr.state.vtxos.find(v => v.id === 'pending').state, 'spent');
assert.equal(adoptArkSnapshot(mgr, restored.arkState), false);
assert.equal(saves, 1);
console.log('✓ connected wallet adopts change without restarting or breaking active payments');

// Before the ASP handshake, every device snapshot is parked under its server
// key. Older snapshots arriving last must not overwrite newer change coins.
let extension;
const parkingWallet = { _cacheKey: () => 'parking-test', registerCacheExtension: e => { extension = e; } };
arkFeature({ wallet: parkingWallet, ui: {}, render: () => {} });
const serverPubkey = '02' + 'ab'.repeat(32);
const freshState = { ...restored.arkState, serverPubkey };
extension.load({ arkState: freshState });
extension.load({ arkState: { serverPubkey, vtxos: [], actions: [], movements: [] } });
const held = JSON.parse(localStorage.getItem(parkingWallet._arkHoldKey(serverPubkey)));
assert.equal(balance(held), 4499);
assert.equal(held.movements[0].amountSat, 501);
console.log('✓ older snapshots cannot overwrite recovery while the ASP is connecting');
featureBox.clear();
assert.equal(featureBox.records().length, 0);
console.log('✓ explicit forget-all removes encrypted recovery copies');
process.exit(0); // the feature schedules a lazy-connect callback; no live ASP in this test
