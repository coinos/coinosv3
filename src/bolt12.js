// BOLT 12 offers and invoices — decode and verify, client-side.
//
// An offer (`lno1…`) names who to pay; the ASP's CLN fetches the actual
// invoice (`lni…`) over onion messages (fetchBolt12Invoice in
// src/ark/lightning.js). The invoice's payment hash MUST be extracted and
// its signature verified HERE: an HTLC locked to a hash the server supplied
// on trust could be claimed with a preimage the server already knows,
// without the recipient ever being paid.
//
// The signature scheme (BOLT 12 "Signature Calculation", mirrored from
// LDK's offers/merkle.rs): every non-signature TLV record contributes two
// leaves — tagged("LnLeaf", record) and tagged("LnNonce"||first-record,
// type-bytes) — pairs combine lexicographically under tagged("LnBranch"),
// the tree reduces in place (odd nodes carry up), and the schnorr message
// is tagged("lightninginvoicesignature", merkle_root).

import { sha256 } from '@noble/hashes/sha256';
import { schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';

const te = new TextEncoder();
const td = new TextDecoder();

// ---------------------------------------------------------------------------
// bech32 without a checksum (BOLT 12 uses the charset, not the checksum;
// `+` followed by whitespace is allowed as a continuation in transport)
// ---------------------------------------------------------------------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('invalid padding');
  return Uint8Array.from(out);
}

export function decodeBech32Raw(str) {
  const s = String(str || '').trim().replace(/\+\s*/g, '');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1) throw new Error('missing prefix');
  const words = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('bad character');
    words.push(v);
  }
  return { hrp: lower.slice(0, pos), bytes: convertBits(words, 5, 8, false) };
}

export function encodeBech32Raw(hrp, bytes) {
  const words = convertBits(bytes, 8, 5, true);
  let out = hrp + '1';
  for (const w of words) out += CHARSET[w];
  return out;
}

// ---------------------------------------------------------------------------
// TLV stream (bigsize types/lengths, truncated big-endian integers)
// ---------------------------------------------------------------------------

function readBigSize(b, off) {
  const first = b[off];
  if (first < 0xfd) return [first, off + 1];
  if (first === 0xfd) return [(b[off + 1] << 8) | b[off + 2], off + 3];
  if (first === 0xfe) return [((b[off + 1] << 24) >>> 0) + (b[off + 2] << 16) + (b[off + 3] << 8) + b[off + 4], off + 5];
  let v = 0n;
  for (let i = 1; i <= 8; i++) v = (v << 8n) | BigInt(b[off + i]);
  return [Number(v), off + 9];
}

const tu64 = (v) => { let n = 0n; for (const b of v) n = (n << 8n) | BigInt(b); return n; };

// → [{ type, value, raw (whole record), typeRaw (just the type bytes) }]
export function parseTlvStream(bytes) {
  const records = [];
  let off = 0;
  while (off < bytes.length) {
    const start = off;
    let type, len;
    [type, off] = readBigSize(bytes, off);
    const typeEnd = off;
    [len, off] = readBigSize(bytes, off);
    if (off + len > bytes.length) throw new Error('truncated TLV stream');
    records.push({
      type,
      value: bytes.slice(off, off + len),
      raw: bytes.slice(start, off + len),
      typeRaw: bytes.slice(start, typeEnd),
    });
    off += len;
  }
  return records;
}

// ---------------------------------------------------------------------------
// offers and invoices
// ---------------------------------------------------------------------------

// genesis chain hashes as they appear in offer_chains / invreq_chain
const CHAINS = {
  '6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000': 'mainnet',
  '43497fd7f826957108f4a30fd9cec3aeba79972084e90ead01ea330900000000': 'testnet',
  f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000: 'signet',
  '06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f': 'regtest',
};
// absent chain TLV = bitcoin mainnet; an unrecognized hash (custom signets) = null
const chainNet = (v) => (v ? (CHAINS[hex.encode(v.slice(0, 32))] || null) : 'mainnet');

export function decodeOffer(str) {
  const { hrp, bytes } = decodeBech32Raw(str);
  if (hrp !== 'lno') throw new Error('not a payment offer');
  const records = parseTlvStream(bytes);
  const out = { bytes, records, network: 'mainnet' };
  for (const r of records) {
    if (r.type === 2) out.network = chainNet(r.value);
    else if (r.type === 6) out.currency = td.decode(r.value);
    else if (r.type === 8) out.amountMsat = tu64(r.value);
    else if (r.type === 10) out.description = td.decode(r.value);
    else if (r.type === 16) out.hasPaths = true;
    else if (r.type === 18) out.issuer = td.decode(r.value);
    else if (r.type === 22) out.issuerPubkey = hex.encode(r.value);
  }
  return out;
}

export function decodeBolt12Invoice(input) {
  let bytes = input;
  if (typeof input === 'string') {
    const dec = decodeBech32Raw(input);
    if (dec.hrp !== 'lni') throw new Error('not a bolt12 invoice');
    bytes = dec.bytes;
  }
  const records = parseTlvStream(bytes);
  const out = { bytes, records, network: 'mainnet' };
  for (const r of records) {
    if (r.type === 2 || r.type === 80) out.network = chainNet(r.value);
    else if (r.type === 10) out.description = td.decode(r.value);
    else if (r.type === 164) out.createdAt = Number(tu64(r.value));
    else if (r.type === 166) out.relativeExpiry = Number(tu64(r.value));
    else if (r.type === 168) out.paymentHash = hex.encode(r.value);
    else if (r.type === 170) out.amountMsat = tu64(r.value);
    else if (r.type === 176) out.nodeId = hex.encode(r.value);
    else if (r.type === 240) out.signature = r.value;
  }
  if (!out.paymentHash || out.paymentHash.length !== 64) throw new Error('invoice missing payment hash');
  if (out.amountMsat == null) throw new Error('invoice missing amount');
  out.amountSat = Number((out.amountMsat + 999n) / 1000n); // bark rounds msats up
  out.expiresAt = ((out.createdAt || 0) + (out.relativeExpiry ?? 7200)) * 1000;
  return out;
}

// ---------------------------------------------------------------------------
// signature verification
// ---------------------------------------------------------------------------

const taggedEngine = (tagHash) => {
  const parts = [tagHash, tagHash];
  return (msg) => sha256(concat([...parts, msg]));
};
function concat(arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function merkleRoot(records) {
  const usable = records.filter((r) => r.type < 240 || r.type > 1000);
  if (!records.length) throw new Error('empty TLV stream');
  const leafHash = taggedEngine(sha256(te.encode('LnLeaf')));
  // the nonce tag commits to the FIRST record of the whole stream
  const nonceHash = taggedEngine(sha256(concat([te.encode('LnNonce'), records[0].raw])));
  const branch = taggedEngine(sha256(te.encode('LnBranch')));
  const leaves = [];
  for (const r of usable) {
    leaves.push(leafHash(r.raw));
    leaves.push(nonceHash(r.typeRaw));
  }
  const cmp = (a, b) => { for (let i = 0; i < 32; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
  // in-place reduction, unpaired nodes carry up (mirrors LDK root_hash)
  const n = leaves.length;
  for (let level = 0; ; level++) {
    const step = 2 << level;
    const offset = step / 2;
    if (offset >= n) break;
    for (let i = 0, j = offset; j < n; i += step, j += step) {
      const [lo, hi] = cmp(leaves[i], leaves[j]) < 0 ? [leaves[i], leaves[j]] : [leaves[j], leaves[i]];
      leaves[i] = branch(concat([lo, hi]));
    }
  }
  return leaves[0];
}

// Throws unless the invoice is signed by the offer's issuer and mirrors the
// offer's terms. An offer that names no issuer key (blinded-path-only) can't
// be pinned to a stable key here — the signature and mirrored TLVs are still
// checked, and CLN validated issuance when it fetched the invoice.
export function verifyOfferInvoice(offer, invoice) {
  if (!invoice.signature || invoice.signature.length !== 64) throw new Error('invoice is unsigned');
  if (!invoice.nodeId || invoice.nodeId.length !== 66) throw new Error('invoice names no signer');
  // every offer term must be mirrored byte-for-byte in the invoice
  const invRaw = new Set(invoice.records.map((r) => hex.encode(r.raw)));
  for (const r of offer.records) {
    if (r.type >= 1 && r.type <= 79 && !invRaw.has(hex.encode(r.raw))) {
      throw new Error('invoice does not match the offer');
    }
  }
  if (offer.issuerPubkey && offer.issuerPubkey !== invoice.nodeId) {
    throw new Error('invoice signed by the wrong node');
  }
  const digest = taggedEngine(sha256(te.encode('lightninginvoicesignature')))(merkleRoot(invoice.records));
  const xonly = hex.decode(invoice.nodeId).slice(1);
  if (!schnorr.verify(invoice.signature, digest, xonly)) throw new Error('invalid invoice signature');
}
