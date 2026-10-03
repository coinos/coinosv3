// A renewal remembers its round's transaction as soon as the round has run —
// before that transaction confirms, which is exactly when someone wants to
// look it up — so the coins page (and later the history row) can link to it.
// Run: bun tools/ark/renew-txid-test.js
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { hex } from '@scure/base';

const refresh = await import('../../src/ark/refresh.js');
// version 2, one input, one 1000-sat OP_TRUE output
const rawTx = hex.decode('02000000' + '01' + '11'.repeat(32) + '00000000' + '00' + 'ffffffff' + '01' + 'e803000000000000' + '0151' + '00000000');
const wantTxid = refresh.parseTx(rawTx).txid;
let roundRan = false;
mock.module('../../src/ark/refresh.js', () => ({
  ...refresh,
  roundParticipationStatus: async () => (roundRan ? { status: 1, fundingTx: rawTx, outputVtxos: [] } : { status: 0 }),
}));
const { ArkManager } = await import('../../src/ark/manager.js');
let saves = 0;
const mgr = new ArkManager({ storage: { save() { saves++; } }, arkUrl: 'http://test.invalid' });
const asked = [];
Object.defineProperty(mgr, 'chain', { value: { getTxStatus: async (txid) => { asked.push(txid); return { confirmed: false }; } } });
const action = { id: 'refresh-1', type: 'refresh', step: 'submitted', inputIds: ['a:0'], outKeyIndex: 1, outAmountSat: 900, feeSat: 0, unlockHash: '22'.repeat(32) };
mgr.state = { nextKeyIndex: 2, movements: [], actions: [action], vtxos: [{ id: 'a:0', amountSat: 900, expiryHeight: 500, state: 'pending' }] };
mgr._refreshOutputs = () => [];

await mgr._driveRefresh(action);
assert.equal(action.fundingTxid, undefined, 'no transaction before the round has run');
assert.equal(action.step, 'submitted');
console.log('✓ Before the round runs there is no transaction to point at');

roundRan = true;
const before = saves;
await mgr._driveRefresh(action);
assert.equal(action.fundingTxid, wantTxid, 'the round transaction is kept');
assert.equal(action.step, 'submitted', 'still waiting for the confirmation');
assert.deepEqual(asked, [wantTxid]);
assert(saves > before, 'and saved, so a reload still has it');
console.log('✓ Once the round has run its transaction id is kept, though unconfirmed: ' + wantTxid.slice(0, 16) + '…');

const again = saves;
await mgr._driveRefresh(action);
assert.equal(saves, again, 'not saved again on every sync while it waits');
console.log('✓ ...and waiting for the confirmation writes nothing more');
console.log('\n✅ a renewal knows its round transaction');
