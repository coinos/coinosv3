// Local ark state pruning: spent coins shed bytes once their spend is old and
// unreferenced; done actions shed output hex; nothing live is touched.
// Run: bun tools/ark-prune-test.js
import assert from 'node:assert/strict';
import { pruneArkState } from '../src/ark/manager.js';

const DAY = 86400_000;
const now = 1_800_000_000_000;
const state = {
  vtxos: [
    { id: 'live', state: 'spendable', bytes: 'LIVE' },
    { id: 'oldspent', state: 'spent', bytes: 'OLD=' },        // spent 40d ago → bytes go
    { id: 'freshspent', state: 'spent', bytes: 'NEW=' },      // spent yesterday → kept
    { id: 'inflight', state: 'spent', bytes: 'FLY=' },        // named by a live action → kept
    { id: 'unnamed', state: 'spent', bytes: 'UNK=' },         // no date known → kept
    { id: 'pending', state: 'pending', bytes: 'PND=' },
  ],
  actions: [
    { id: `send-${now - 40 * DAY}`, type: 'send', step: 'done', inputIds: ['oldspent'], destBytesList: ['hex'], changeBytesList: ['hex'], amountSat: 5 },
    { id: `ln-pay-${now - 1 * DAY}`, type: 'ln-pay', step: 'done', inputIds: ['freshspent'], htlcBytesList: ['hex'], preimage: 'p' },
    { id: `send-${now - 3 * DAY}`, type: 'send', step: 'submitted', inputIds: ['inflight'], changeBytesList: ['hex'] },
    { id: `board-${now - 30 * DAY}`, type: 'board', step: 'done', fundingTxHex: 'ff', outputVtxos: ['hex'], fundingTxid: 'x' },
    { id: `ln-pay-${now - 10 * DAY}`, type: 'ln-pay', step: 'failed', htlcBytesList: ['hex'] },
  ],
  movements: [{ id: 'm1', type: 'send', status: 'complete', ts: now - 40 * DAY, inputIds: ['oldspent'] }],
};
const before = JSON.stringify(state).length;
pruneArkState(state, now);
const v = (id) => state.vtxos.find((x) => x.id === id);
assert.equal(v('live').bytes, 'LIVE');
assert.equal(v('pending').bytes, 'PND=');
assert.equal(v('oldspent').bytes, undefined, 'old spend sheds its bytes');
assert.equal(v('freshspent').bytes, 'NEW=', 'a recent spend keeps them');
assert.equal(v('inflight').bytes, 'FLY=', 'an in-flight action pins them');
assert.equal(v('unnamed').bytes, 'UNK=', 'no known spend date → keep');
const a = (i) => state.actions[i];
assert.ok(!('destBytesList' in a(0)) && !('changeBytesList' in a(0)) && a(0).amountSat === 5 && a(0).inputIds[0] === 'oldspent', 'old done action loses hex, keeps ids');
assert.equal(a(1).htlcBytesList[0], 'hex', 'a day-old done action still has its hex');
assert.equal(a(2).changeBytesList[0], 'hex', 'in-flight action untouched');
assert.ok(!('fundingTxHex' in a(3)) && !('outputVtxos' in a(3)) && a(3).fundingTxid === 'x');
assert.equal(a(4).htlcBytesList[0], 'hex', 'a failed ln-pay keeps its HTLC bytes for the refund');
assert.ok(JSON.stringify(state).length < before);
pruneArkState(state, now);
console.log('✓ ark state pruning is selective and idempotent');

// ---- bytes encoding: base64 persisted, hex still readable, hex on the wire ----
import { vtxoBytesToStr, vtxoBytesFromStr, vtxoBytesToHex, vtxoBytesNormalize } from '../src/ark/proto.js';
import { slimArkForSync } from '../src/features/ark.js';
const raw = new Uint8Array(300).map((_, i) => (i * 37) & 255);
const hexStr = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = vtxoBytesToStr(raw);
assert.ok(b64.length < hexStr.length * 0.7);
assert.deepEqual(vtxoBytesFromStr(b64), raw);
assert.deepEqual(vtxoBytesFromStr(hexStr), raw, 'hex from older builds still decodes');
assert.equal(vtxoBytesNormalize(hexStr), b64);
assert.equal(vtxoBytesNormalize(b64), b64);
assert.equal(vtxoBytesToHex(b64), hexStr);
const st2 = { vtxos: [{ id: 'a', state: 'spendable', bytes: hexStr }, { id: 'b', state: 'spent', bytes: hexStr }], actions: [], movements: [] };
pruneArkState(st2, now);
assert.equal(st2.vtxos[0].bytes, b64, 'a save converts persisted hex to base64');
assert.equal(st2.vtxos[1].bytes, b64);
assert.equal(slimArkForSync(st2).vtxos[0].bytes, hexStr, 'the sync wire stays hex for older devices');
console.log('✓ vtxo bytes persist as base64, read hex, ship hex');
