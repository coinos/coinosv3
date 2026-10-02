// ArkManager.lnLookup — the NIP-47 lookup_invoice answer, from wallet state.
//   bun tools/ln-lookup-test.js
import { hex } from '@scure/base';
import { ArkManager } from '../src/ark/manager.js';
import { decodeBolt11 } from '../src/ark/lightning.js';

let ok = true;
const check = (n, c, d = '') => { console.log(` ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) ok = false; };
const INV = 'lnbc210n1p4xuk2wpp506wkjr0xk3677nu7je9c55vq4lzlkyd0ztcq2mlvumap0zpe3alqhp5ppg7g8qwpdv34hgpymhw446y37duzwcn388yp3pw05n7tlulyn2scqzysxqrrssrzjqv3dpepm8kfdxrk3sl6wzqdf49s9c0h9ljtjrek6c08r6aejlwcnur0dwyqqvusqqqqqqqlgqqqq86qqjqsp5dc0jrq94ke2f4dzx8c2dwqsc6a65eu56dt2j599l7kxp7q2hs6zq9qxpqysgqdjeft8gkl0uga24e502pvcp5vgsfap3dxuutcpgfaj33fffuqs9psmnrklshp3fg3py7vlnzsea90vj9ahqq5t9xuy67u3pk0sfnheqpn95f2g';
const dec = decodeBolt11(INV);
const H = dec.paymentHash;
const pre = new Uint8Array(32).fill(7);
const mgr = (state) => {
  const m = Object.create(ArkManager.prototype);
  m.state = { actions: [], movements: [], ...state };
  m._lnPreimage = () => pre;
  return m;
};
const recv = (step) => ({ id: `lnrecv-${Date.now()}`, type: 'ln-recv', step, paymentHash: H, preimageIndex: 3, amountSat: 21, invoice: INV, expiresAt: dec.expiresAt });

check('unknown hash → null', mgr({}).lnLookup({ paymentHash: 'ab'.repeat(32) }) === null);
check('no hash or invoice → null', mgr({}).lnLookup({}) === null);
let t = mgr({ actions: [recv('awaiting')] }).lnLookup({ paymentHash: H });
check('an awaiting receive past its expiry reads expired', t.type === 'incoming' && t.state === 'expired' && !t.preimage, JSON.stringify(t));
t = mgr({ actions: [{ ...recv('awaiting'), invoice: INV }] }).lnLookup({ invoice: INV });
check('found by bolt11 as well as hash', t && t.payment_hash === H);
t = mgr({ actions: [recv('htlcsReady')] }).lnLookup({ paymentHash: H });
check('HTLCs in, not yet claimed → pending, no preimage', t.state === 'pending' && !t.preimage, t.state);
t = mgr({ actions: [recv('done')], movements: [{ type: 'ln-receive', status: 'complete', invoice: INV, amountSat: 21, ts: 1700000000000 }] }).lnLookup({ paymentHash: H.toUpperCase() });
check('claimed → settled with the preimage', t.state === 'settled' && t.preimage === hex.encode(pre) && t.amount === 21000 && t.settled_at === 1700000000, JSON.stringify(t));
t = mgr({ actions: [{ id: 'lnpay-1700000000000', type: 'ln-pay', step: 'done', paymentHash: H, invoice: INV, amountSat: 21, feeSat: 1, preimage: 'ab'.repeat(32) }] }).lnLookup({ paymentHash: H });
check('a paid invoice reads outgoing, settled, with fees', t.type === 'outgoing' && t.state === 'settled' && t.preimage === 'ab'.repeat(32) && t.fees_paid === 1000, JSON.stringify(t));
t = mgr({ actions: [{ id: 'lnpay-1', type: 'ln-pay', step: 'failed', paymentHash: H, invoice: INV, amountSat: 21 }] }).lnLookup({ paymentHash: H });
check('a failed send reads failed', t.state === 'failed');
t = mgr({ movements: [{ type: 'ln-send', status: 'complete', invoice: INV, preimage: 'cd'.repeat(32), paymentHash: H, amountSat: 21, ts: 1 }] }).lnLookup({ paymentHash: H });
check('history alone (action pruned) still answers', t && t.type === 'outgoing' && t.state === 'settled' && t.preimage === 'cd'.repeat(32));
console.log(ok ? '\n✅ lnLookup answers lookup_invoice' : '\n❌ failures');
process.exit(ok ? 0 : 1);
