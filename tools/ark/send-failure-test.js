// A rejected package must reject send(), retain the unspent inputs, and
// appear as a failed attempt rather than a successful payment.
// Run: bun tools/ark/send-failure-test.js
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeAddress, GrpcError } from '../../src/ark/proto.js';

const send = await import('../../src/ark/send.js');
let cosigns = 0;
const badId = 'a'.repeat(64) + ':0';
const error = new GrpcError(3, `bad user input: vtxo ${badId} expired at height 100 (tip = 200)`, 'RequestArkoorCosign');
mock.module('../../src/ark/send.js', () => ({
  ...send,
  registerVtxoTransactions: async () => {},
  buildArkoorSend: () => ({}),
  cosignPackageWithServer: async () => { cosigns++; throw error; },
}));
const { ArkManager } = await import('../../src/ark/manager.js');
const key = n => secp256k1.getPublicKey(new Uint8Array(32).fill(n), true);
const dest = encodeAddress({ testnet: true, serverPubkey: key(1), userPubkey: key(2), blindedMailboxId: new Uint8Array(32).fill(3) });
const mgr = new ArkManager({ storage: { save() {} }, arkUrl: 'http://test.invalid' });
mgr.serverPub = key(1);
mgr.state = {
  nextKeyIndex: 1, movements: [], actions: [],
  vtxos: [
    { id: badId, amountSat: 1, expiryHeight: 100, state: 'spendable' },
    { id: 'b'.repeat(64) + ':0', amountSat: 180, expiryHeight: 500, state: 'spendable' },
  ],
};
Object.defineProperty(mgr, 'chain', { value: { tipHeight: async () => 200 } });
mgr._decoded = () => ({ _raw: { bytes: new Uint8Array() } });
mgr._keyForVtxo = () => ({});

await assert.rejects(mgr.send(dest, 181), /expired at height 100/);
assert.equal(mgr.state.actions[0].step, 'failed');
assert.ok(mgr.state.vtxos.every(v => v.state === 'spendable'), 'atomic rejection does not consume either input');
assert.deepEqual(mgr.balance(), { spendableSat: 180, pendingSat: 0, boardingSat: 0, expiredSat: 1 });
assert.equal(mgr.state.movements[0].status, 'failed');
assert.equal(mgr.state.movements[0].to, dest);
assert.equal(mgr.pendingActions().length, 0, 'a definitive rejection is not automatically retried');
console.log('✓ a rejected send throws, preserves unspent inputs, and records failure');

await assert.rejects(mgr.send(dest, 181), /1 sat expired and unusable/);
assert.equal(cosigns, 1, 'send-all does not reuse the rejected coin');
assert.equal(mgr._selectInputs(180, 200)[0].amountSat, 180);
assert.equal(mgr._expired({ amountSat: 1, expiryHeight: 100 }, 200), false, 'other dust retains its existing policy');
delete mgr.state.vtxos[0].expiryRejected;
assert.equal(mgr._recordExpiryRejection(mgr.state.actions[0]), true);
assert.equal(mgr.balance().spendableSat, 180, 'old failed actions repair the displayed balance');
assert.equal(mgr._recordExpiryRejection(mgr.state.actions[0]), false, 'repair is idempotent');
assert.equal(mgr._recordExpiryRejection({ ...mgr.state.actions[0], parts: [] }), false, 'only inputs of that failed action can be marked');
console.log('✓ known expired inputs stay excluded after reload; the usable 180 sats remain selectable');

mgr._driveSend = async action => { action.step = 'done'; };
assert.match(await mgr.send(dest, 180), /^send-/);
console.log('✓ a completed send still returns its action ID');

const { arkFeature } = await import('../../src/features/ark.js');
const h = (tag, props, ...children) => ({ tag, props, children: children.flat().filter(x => x != null && x !== false) });
const text = n => typeof n === 'object' ? n.children.map(text).join('') : String(n);
const feature = arkFeature({ h, ui: {}, render() {}, fmtAmount: String, unitLabel: () => 'sats', hook: () => null,
  wallet: { registerCacheExtension() {}, loadFeatureState: () => ({}) } });
const rows = feature._histBuild({ movements: [{ id: 'failed-send', type: 'send', status: 'failed', amountSat: 181, ts: Date.now() }], actions: [], vtxos: [] });
assert.equal(rows.length, 1);
const label = text(rows[0].render());
assert.match(label, /Payment failed/);
assert.ok(!label.includes('-181'), 'a rejected amount is not displayed as money spent');
console.log('✓ history includes the failed attempt without claiming a debit');
process.exit(0);
