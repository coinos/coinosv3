// BOLT 12 decode + signature verification against a REAL offer/invoice pair
// (fetched from a live CLN via fetchinvoice) plus tamper checks.
// Run: bun tools/bolt12-test.js [offer-file invoice-file]
import { readFileSync } from 'node:fs';
import {
  decodeOffer, decodeBolt12Invoice, verifyOfferInvoice, encodeBech32Raw, decodeBech32Raw,
} from '../src/bolt12.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(` ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 140) : ''}`);
  if (!ok) fails++;
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const [offerFile, invoiceFile] = process.argv.slice(2);
const offerStr = readFileSync(offerFile || '/tmp/claude-1000/-home-adam-coinosv3/556b3f05-c728-4e11-a426-50382ad8bd8d/scratchpad/fixture-offer.txt', 'utf8').trim();
const invStr = readFileSync(invoiceFile || '/tmp/claude-1000/-home-adam-coinosv3/556b3f05-c728-4e11-a426-50382ad8bd8d/scratchpad/fixture-invoice.txt', 'utf8').trim();

console.log('[codec]');
const rt = decodeBech32Raw(invStr);
check('lni hrp', rt.hrp === 'lni');
check('bech32 roundtrips', encodeBech32Raw('lni', rt.bytes) === invStr.toLowerCase());

console.log('\n[offer]');
const offer = decodeOffer(offerStr);
check('decodes', !!offer.records.length, `${offer.records.length} records`);
check('mainnet', offer.network === 'mainnet');
check('describes itself', typeof offer.description === 'string', offer.description);

console.log('\n[invoice]');
const inv = decodeBolt12Invoice(invStr);
check('payment hash present', /^[0-9a-f]{64}$/.test(inv.paymentHash || ''), inv.paymentHash);
check('amount = 12345 msat', inv.amountMsat === 12345n, String(inv.amountMsat));
check('amount rounds up to 13 sat', inv.amountSat === 13);
check('signer named', /^[0-9a-f]{66}$/.test(inv.nodeId || ''), inv.nodeId);
check('expiry sane', inv.expiresAt > Date.now() - 86400_000, new Date(inv.expiresAt).toISOString());

console.log('\n[verification]');
check('real invoice verifies', throws(() => verifyOfferInvoice(offer, inv)) === null,
  throws(() => verifyOfferInvoice(offer, inv)) || 'ok');

// tamper with the amount TLV: signature must fail
const tampered = decodeBolt12Invoice(invStr);
const amtRec = tampered.records.find((r) => r.type === 170);
amtRec.raw[amtRec.raw.length - 1] ^= 1;
check('tampered amount rejected', /signature/.test(throws(() => verifyOfferInvoice(offer, tampered)) || ''));

// swap in a different offer description: mirror check must fail
const wrongOffer = decodeOffer(offerStr);
const descRec = wrongOffer.records.find((r) => r.type === 10);
if (descRec) {
  descRec.raw[descRec.raw.length - 1] ^= 1;
  check('mismatched offer rejected', /match/.test(throws(() => verifyOfferInvoice(wrongOffer, inv)) || ''));
}

// forged signer: issuer pin must fail
const forged = decodeBolt12Invoice(invStr);
forged.nodeId = '02' + '11'.repeat(32);
check('wrong signer rejected', /wrong node|signature/.test(throws(() => verifyOfferInvoice(offer, forged)) || ''));

console.log(fails ? `\n❌ ${fails} failure(s)` : '\n✅ bolt12 verifies');
process.exit(fails ? 1 : 0);
