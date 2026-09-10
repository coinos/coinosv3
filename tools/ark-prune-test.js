// Local ark state pruning: spent coins shed bytes once their spend is old and
// unreferenced; done actions shed output hex; nothing live is touched.
// Run: bun tools/ark-prune-test.js
import assert from 'node:assert/strict';
import { pruneArkState } from '../src/ark/manager.js';

const DAY = 86400_000;
const now = 1_800_000_000_000;
const state = {
  vtxos: [
    { id: 'live', state: 'spendable', bytes: 'aa' },
    { id: 'oldspent', state: 'spent', bytes: 'bb' },        // spent 40d ago → bytes go
    { id: 'freshspent', state: 'spent', bytes: 'cc' },      // spent yesterday → kept
    { id: 'inflight', state: 'spent', bytes: 'dd' },        // named by a live action → kept
    { id: 'unnamed', state: 'spent', bytes: 'ee' },         // no date known → kept
    { id: 'pending', state: 'pending', bytes: 'ff' },
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
assert.equal(v('live').bytes, 'aa');
assert.equal(v('pending').bytes, 'ff');
assert.equal(v('oldspent').bytes, undefined, 'old spend sheds its bytes');
assert.equal(v('freshspent').bytes, 'cc', 'a recent spend keeps them');
assert.equal(v('inflight').bytes, 'dd', 'an in-flight action pins them');
assert.equal(v('unnamed').bytes, 'ee', 'no known spend date → keep');
const a = (i) => state.actions[i];
assert.ok(!('destBytesList' in a(0)) && !('changeBytesList' in a(0)) && a(0).amountSat === 5 && a(0).inputIds[0] === 'oldspent', 'old done action loses hex, keeps ids');
assert.equal(a(1).htlcBytesList[0], 'hex', 'a day-old done action still has its hex');
assert.equal(a(2).changeBytesList[0], 'hex', 'in-flight action untouched');
assert.ok(!('fundingTxHex' in a(3)) && !('outputVtxos' in a(3)) && a(3).fundingTxid === 'x');
assert.equal(a(4).htlcBytesList[0], 'hex', 'a failed ln-pay keeps its HTLC bytes for the refund');
assert.ok(JSON.stringify(state).length < before);
pruneArkState(state, now);
console.log('✓ ark state pruning is selective and idempotent');
