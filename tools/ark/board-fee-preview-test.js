// Fee previews use the real wallet transaction builder, without signing or
// broadcasting anything. Run: bun tools/ark/board-fee-preview-test.js
import assert from 'node:assert/strict';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { Wallet } from '../../src/wallet.js';
import { previewBoardFunding } from '../../src/features/ark.js';
import { p2trAddress } from '../../src/ark/board.js';

const wallet = new Wallet();
wallet.load({ mnemonic: generateMnemonic(wordlist), netName: 'mainnet', offline: true });
wallet.utxos = [{ txid: 'a'.repeat(64), vout: 0, value: 300000, chain: 0, index: 0, confirmed: true }];
wallet.feeRates = { halfHourFee: 1 };
const ark = { info: { network: 'bitcoin', boardFees: {} }, _key: () => ({ pubkey: wallet.derive(0, 0).pubkey }) };
// A different P2TR program stands in for the final funding address. Its
// output size matches the preview while its key is unrelated to the probe.
const fundingAddress = p2trAddress(wallet.derive(0, 1).pubkey.slice(1), 'bc');
const actualDraft = sats => wallet.buildTx({ recipients: [{ address: fundingAddress, amount: sats }],
  feeRate: wallet.feeRates.halfHourFee, noSort: true });

const max = previewBoardFunding(wallet, ark, 0, true);
assert.deepEqual(max, { fundingSat: 299878, chainFeeSat: 122, serviceFeeSat: 0, feeSat: 122, netSat: 299878 });
const maxPreview = previewBoardFunding(wallet, ark, max.fundingSat);
assert.deepEqual(maxPreview, max);
assert.equal(maxPreview.chainFeeSat, actualDraft(max.fundingSat).fee);
assert.equal(maxPreview.netSat + maxPreview.feeSat, 300000);
console.log('✓ 300,000-sat Max shows a 122-sat fee and 299,878 sats arriving');

const partial = previewBoardFunding(wallet, ark, 100000);
assert.equal(partial.netSat, 100000, 'the mining fee is paid from Savings, not deducted again from the deposit');
assert.equal(partial.chainFeeSat, actualDraft(100000).fee);
assert.ok(partial.chainFeeSat > max.chainFeeSat, 'partial deposits include the change output fee');
console.log('✓ partial deposits include the change output and preserve the correct received amount');

ark.info.boardFees = { baseFeeSat: 25, ppm: 1000 };
const service = previewBoardFunding(wallet, ark, max.fundingSat);
assert.equal(service.serviceFeeSat, 325);
assert.equal(service.feeSat, 447);
assert.equal(service.netSat, 299553);
assert.equal(service.netSat + service.feeSat, 300000);
console.log('✓ nonzero service fees are included in the total and deducted exactly once');

ark.info.boardFees = {};
wallet.utxos = [
  { txid: 'a'.repeat(64), vout: 0, value: 200000, chain: 0, index: 0, confirmed: true },
  { txid: 'b'.repeat(64), vout: 0, value: 100000, chain: 0, index: 1, confirmed: true },
];
wallet.feeRates.halfHourFee = 1.6;
const multi = previewBoardFunding(wallet, ark, 0, true);
assert.equal(multi.chainFeeSat, actualDraft(multi.fundingSat).fee);
assert.equal(multi.netSat + multi.feeSat, 300000);
assert.ok(multi.feeSat > max.feeSat);
assert.throws(() => previewBoardFunding(wallet, ark, 300000), /Insufficient funds/);
console.log('✓ multiple inputs, fee-rate rounding, and insufficient funds follow the actual funding transaction');
process.exit(0);
