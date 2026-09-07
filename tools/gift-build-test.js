// Exercises the on-chain (Savings) gift BUILDER — the path that had no
// coverage and shipped a "Cannot mix BigInt and other types" crash: the funding
// fee (a Number) was subtracted from BigInt coin sums in _buildGiftPsbt. Builds
// real gifts (specific amount, whole-balance, and the split carve-out) against a
// mock wallet and asserts they don't throw and produce claimable v2 codes.
import assert from 'node:assert';
import { HDKey } from '@scure/bip32';
import { p2wpkh } from '@scure/btc-signer/payment';
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha256';

// localStorage shim (reserved/reclaimed sets persist through it)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { installGiftWallet, parseLazyGift, previewGift, giftClaimTxs } = await import('../src/features/gifts-wallet.js');

const master = HDKey.fromMasterSeed(sha256(new TextEncoder().encode('gift-build-test-seed')));
const child = (chain, index) => master.derive(`m/84'/0'/0'/${chain}/${index}`);
const NET = btc.NETWORK;

function mockWallet(utxos) {
  const w = {
    utxos,
    netCfg: { net: NET },
    feeRates: { halfHourFee: 5 },
    _cacheKey: () => 'giftbuildtest',
    _loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); } },
    derive: (chain, index) => {
      const n = child(chain, index);
      return { pubkey: n.publicKey, address: p2wpkh(n.publicKey, NET).address };
    },
    node: (chain, index) => ({ privateKey: child(chain, index).privateKey }),
    freshChange: () => ({ address: p2wpkh(child(1, 0).publicKey, NET).address }),
    isReserved(id) { return this.reservedSet().has(id); },
    saveCache() {},
    registerCoinLock() {},
    registerCacheExtension() {},
  };
  installGiftWallet(w);
  return w;
}

const coin = (value, i = 0) => ({ txid: '11'.repeat(32).slice(0, 64), vout: i, value, chain: 0, index: i, confirmed: true });

// 1) specific-amount gift from one big coin (the screenshot scenario: 99,847
//    coin, gift ~2,500) — the sum - gift - fundFee(2) path.
{
  const w = mockWallet([coin(99847, 0)]);
  const g = w.createGift(2500, 5);
  assert.ok(g.code && g.amount === 2500, 'specific-amount gift built');
  const parsed = parseLazyGift(g.code);
  assert.ok(parsed && parsed.tx.getOutput(0).amount === 2500n, 'v2 code parses, E holds the gift');
  assert.equal(previewGift(g.code).room, 2500, 'preview room = gift');
  const claim = giftClaimTxs(g.code, w.freshChange().address, 5, NET);
  assert.ok(claim.funding.hex && claim.sweep.hex && claim.amount > 0, 'claim funding+sweep build');
  store.clear();
  console.log('✓ specific-amount on-chain gift builds + claims (no BigInt crash)');
}

// 2) whole-balance gift (createGiftAll) — the sum - fundFee(1) path that crashed.
{
  const w = mockWallet([coin(30000, 0), coin(20000, 1)]);
  const g = w.createGiftAll(5);
  assert.ok(g.code && g.amount > 0 && g.amount < 50000, 'whole-balance gift built (amount = sum - fee)');
  assert.ok(parseLazyGift(g.code), 'whole-balance code parses');
  store.clear();
  console.log('✓ whole-balance on-chain gift builds (no BigInt crash)');
}

// 3) the split carve-out shape: _buildGiftPsbt on a coin sized gift + 1-output
//    fee, which lands in the dust-drop branch (sum - gift < fundFee(2)).
{
  const rate = 5;
  const w = mockWallet([]);
  const carveFee = Math.max(1, Math.ceil((11 + 68 + 31) * rate)); // _giftFundFee(1,1,rate)
  const gift = 2500;
  const carve = coin(gift + carveFee, 0);
  const g = w._buildGiftPsbt([carve], BigInt(gift), rate);
  assert.equal(g.amount, gift, 'split carve funds exactly the gift');
  assert.ok(parseLazyGift(g.code), 'split gift code parses');
  console.log('✓ split carve-out gift builds (dust-drop fee path, no BigInt crash)');
}

console.log('\n✅ on-chain gift builder passes');
