// Why a Lightning payment can't be covered — so the wallet says "your coins
// are being renewed" or "not enough with the fee" instead of "Payment failed".
// The first case is the 2026-10-03 report: a user renewed all ten coins
// (55,611 sats) from the coins page, tried to pay 55,300 three minutes later,
// and the renewal's round took 64 minutes to confirm.
// Run: bun tools/ark/ln-shortfall-test.js
import { lnShortfall } from '../../src/ark/lightning.js';
let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const coin = (id, amountSat, state) => ({ id, amountSat, state });

const amounts = [3, 54, 54, 49500, 1000, 1000, 1000, 1000, 1000, 1000];
const renewed = amounts.map((a, i) => coin('c' + i, a, 'pending'));
const refresh = { type: 'refresh', step: 'submitted', inputIds: renewed.map((v) => v.id) };
let r = lnShortfall(renewed, [refresh], 55300);
check('every coin in a renewal: the payment is held by the renewal, by name', r.kind === 'renewing' && r.renewingSat === 55611 && r.spendableSat === 0, JSON.stringify(r));

r = lnShortfall(renewed, [{ ...refresh, step: 'done' }], 55300);
check('a finished renewal holds nothing', r.kind !== 'renewing' && r.renewingSat === 0, JSON.stringify(r));

r = lnShortfall([coin('a', 60000, 'pending')], [{ type: 'lnpay', step: 'htlc', inputIds: ['a'] }], 55300);
check('coins held by another payment: wait, they free themselves', r.kind === 'settling' && r.settlingSat === 60000, JSON.stringify(r));

r = lnShortfall([coin('a', 30000, 'pending'), coin('b', 30000, 'spendable')], [], 55300);
check('...counted together with what is spendable (it used to take one pending coin covering it all)', r.kind === 'settling', JSON.stringify(r));

r = lnShortfall([coin('a', 55400, 'spendable')], [], 55300);
check('enough for the amount but not its fee: short, not "failed"', r.kind === 'short' && r.spendableSat === 55400, JSON.stringify(r));

r = lnShortfall([coin('a', 100, 'spendable'), coin('b', 200, 'pending')], [{ type: 'refresh', step: 'created', inputIds: ['b'] }], 55300);
check('a renewal that wouldn\'t cover it anyway: short', r.kind === 'short' && r.renewingSat === 200, JSON.stringify(r));

r = lnShortfall([coin('a', 40000, 'pending'), coin('b', 20000, 'pending')], [{ type: 'refresh', step: 'issued', inputIds: ['a'] }, { type: 'lnpay', step: 'htlc', inputIds: ['b'] }], 55300);
check('part renewing, part settling, together enough: the renewal is what it waits on', r.kind === 'renewing', JSON.stringify(r));

r = lnShortfall([coin('a', 60000, 'pending')], [{ type: 'offboard', step: 'submitted', inputIds: ['a'] }], 55300);
check('coins leaving for Savings are not waited for', r.kind === 'short' && r.settlingSat === 0, JSON.stringify(r));
r = lnShortfall([coin('a', 60000, 'pending')], [{ type: 'exit', step: 'chain', vtxoId: 'a' }], 55300);
check('...nor coins in a unilateral exit', r.kind === 'short' && r.settlingSat === 0, JSON.stringify(r));

// the manager's own error (ark sends, and the pay path behind the quote) names it too
const { ArkManager } = await import('../../src/ark/manager.js');
const mgr = new ArkManager({ storage: { save() {} }, arkUrl: 'http://test.invalid' });
mgr.state = { nextKeyIndex: 1, movements: [], actions: [refresh], vtxos: renewed.map((v) => ({ ...v, expiryHeight: 973921 })) };
const msg = mgr._insufficientMsg(969751);
check('the manager\'s "insufficient" says a renewal holds the money', /55611 sat are being renewed/.test(msg), msg);
mgr.state.actions = [];
mgr.state.vtxos = [];
check('...and stays plain when nothing is renewing', mgr._insufficientMsg(969751) === 'insufficient ark balance');

console.log(ok ? '\n✅ a payment that can\'t be covered says why' : '\n❌ failed');
process.exit(ok ? 0 : 1);
