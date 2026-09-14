// End-to-end test of the server-side backstop renewal (scheduled delegated
// refresh) on regtest:
//
//   receive -> register a standing order -> server HOLDS it out of rounds
//   -> scheduled height passes -> server runs the round with the wallet
//   offline -> wallet returns and claims -> spending the coin instead kills
//   its standing order -> a claim still works after the input has EXPIRED
//
// Usage: bun tools/ark/scheduled-refresh-test.js
// Needs the ark-regtest stack (bc, ark-electrs, captaind on :3535).

import { execSync } from 'node:child_process';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';

import { ArkManager } from '../../src/ark/manager.js';

const ARK = process.env.ARK_URL || 'http://127.0.0.1:3535';
const ESPLORA = process.env.ESPLORA_URL || 'http://127.0.0.1:30002';
const BARK = `${process.env.HOME}/bark/target/debug/bark`;
const ALICE = `${BARK} --datadir ${process.env.HOME}/ark-regtest/alice`;
const BCLI = `docker exec bc bitcoin-cli -rpcwallet=coinos`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { shell: '/bin/bash' }).toString().trim();
const mine = (n = 1) => sh(`${BCLI} generatetoaddress ${n} $(${BCLI} getnewaddress) >/dev/null`);
const tipHeight = () => Number(sh(`${BCLI} getblockcount`));

let ok = true;
const check = (name, cond, detail = '') => {
  console.log(` ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) ok = false;
};

const store = { raw: null };
const storage = {
  load: () => (store.raw ? JSON.parse(store.raw) : null),
  save: (s) => { store.raw = JSON.stringify(s); },
};

const mnemonic = generateMnemonic(wordlist);
const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/86'/0'/9'");
const mgr = await new ArkManager({ account, storage, arkUrl: ARK, esploraUrl: ESPLORA }).init();

// This test mines a coin's whole lifetime in step 5, which also expires the
// funding wallet's coins — an expired vtxo can be refreshed but not sent, so
// re-running against a chain that already ran it would fund nothing.
const fundingReady = () => {
  const alice = JSON.parse(sh(`${ALICE} -q vtxos`));
  const tip = tipHeight();
  if (!alice.some((v) => v.expiry_height <= tip)) return;
  console.log(' … refreshing the funding wallet\'s expired coins first');
  sh(`${ALICE} refresh --all >/dev/null`);
  mine(3);
  sh(`${ALICE} -q balance >/dev/null`);
};
fundingReady();

const receive = async (sat) => {
  const before = mgr.balance().spendableSat;
  sh(`${ALICE} -q send ${mgr.address()} "${sat} sat"`);
  for (let i = 0; i < 15 && mgr.balance().spendableSat < before + sat; i++) {
    await mgr.sync();
    await sleep(1000);
  }
  return mgr.balance().spendableSat - before;
};

// --- 1. register a standing order ---
console.log('\n[1] register');
check('received 20000 sat', (await receive(20000)) === 20000, JSON.stringify(mgr.balance()));

const coin = mgr.vtxos().find((v) => v.state === 'spendable');
// aim the backstop a few blocks out so the test doesn't have to mine a month
const runAt = tipHeight() + 3;
const n = await mgr.ensureScheduledRefreshes(coin.expiryHeight - runAt);
const entry = mgr.scheduledRefreshes()[0];
check('one standing order registered', n === 1 && mgr.scheduledRefreshes().length === 1);
check('has an unlock hash', !!entry?.unlockHash, entry?.unlockHash?.slice(0, 16));
check('scheduled at the asked height', entry?.scheduledHeight === runAt, `${entry?.scheduledHeight} vs ${runAt}`);
check('fee priced at the scheduled height',
  entry?.feeSat === mgr.refreshFee([coin], runAt), `${entry?.feeSat} sat`);
check('coin still spendable', mgr._vtxo(coin.id).state === 'spendable');
check('balance untouched', mgr.balance().spendableSat === 20000, JSON.stringify(mgr.balance()));
check('wallet is not busy', mgr.pendingActions().length === 0);

// --- 2. the server holds it until the scheduled height ---
console.log('\n[2] held out of rounds');
await sleep(25_000); // two-plus regtest rounds
await mgr.sync();
check('not claimed early', mgr.scheduledRefreshes().length === 1 && mgr.balance().spendableSat === 20000,
  JSON.stringify(mgr.balance()));
check('coin still spendable while held', mgr._vtxo(coin.id).state === 'spendable');

// --- 3. the round runs with the wallet offline, then the wallet returns ---
console.log('\n[3] runs offline, claimed on return');
mine(3 + 2); // past the scheduled height, plus confirmations for the round funding tx
await sleep(15_000); // let a round include it — no sync() in between: the wallet is "closed"
check('still nothing local while away', mgr.scheduledRefreshes().length === 1);
const claimed = () => mgr.state.actions.some((a) => a.type === 'refresh' && a.step === 'done');
for (let i = 0; i < 25 && !claimed(); i++) { await mgr.sync(); mine(1); await sleep(1500); }
const renewed = mgr.vtxos().find((v) => v.state === 'spendable' && v.id !== coin.id);
if (!renewed) console.log('   actions:', JSON.stringify(mgr.state.actions.map((a) => [a.type, a.step, a.lastError])));
check('standing order consumed', mgr.scheduledRefreshes().length === 0);
check('old coin spent', mgr._vtxo(coin.id).state === 'spent');
check('fresh coin adopted', !!renewed, renewed && `${renewed.amountSat} sat`);
check('balance is the coin minus the scheduled fee',
  mgr.balance().spendableSat === 20000 - entry.feeSat, JSON.stringify(mgr.balance()));
check('expiry clock restarted', !!renewed && renewed.expiryHeight > coin.expiryHeight,
  renewed && `${coin.expiryHeight} -> ${renewed.expiryHeight}`);
check('renewal in history', mgr.movements().some((m) => m.type === 'refresh' && m.status === 'complete'));

// --- 4. spending the coin kills its standing order ---
console.log('\n[4] spend voids the standing order');
const runAt2 = tipHeight() + 50; // far enough out that the round never runs during the test
await mgr.ensureScheduledRefreshes(renewed.expiryHeight - runAt2);
check('standing order for the fresh coin', mgr.scheduledRefreshes().length === 1);
await mgr.send(sh(`${ALICE} -q address`), 5000);
await mgr.sync();
check('dropped once the input is gone', mgr.scheduledRefreshes().length === 0);
check('no orphan action left behind', mgr.pendingActions().length === 0,
  JSON.stringify(mgr.pendingActions().map((a) => [a.type, a.step])));

// --- 5. a claim still works after the input has expired ---
console.log('\n[5] claim after the input expires');
const change = mgr.vtxos().find((v) => v.state === 'spendable');
const runAt3 = tipHeight() + 3;
await mgr.ensureScheduledRefreshes(change.expiryHeight - runAt3);
check('standing order for the change coin', mgr.scheduledRefreshes().length === 1);
mine(5);
await sleep(15_000); // the round runs — still no sync, the wallet is away
mine(change.expiryHeight - tipHeight() + 10); // ...and stays away past the coin's expiry
check('input is expired now', tipHeight() > change.expiryHeight, `tip ${tipHeight()} > ${change.expiryHeight}`);
const claimedAgain = () => mgr.state.actions.filter((a) => a.type === 'refresh' && a.step === 'done').length > 1;
for (let i = 0; i < 25 && !claimedAgain(); i++) { await mgr.sync(); mine(1); await sleep(1500); }
if (!claimedAgain()) console.log('   actions:', JSON.stringify(mgr.state.actions.map((a) => [a.type, a.step, a.lastError])));
const rescued = mgr.vtxos().find((v) => v.id !== change.id && v.state === 'spendable');
check('expired input forfeited, output claimed', mgr.scheduledRefreshes().length === 0 && !!rescued,
  rescued ? `${rescued.amountSat} sat, expiry ${rescued.expiryHeight}` : JSON.stringify(mgr.balance()));
check('expired input is spent, not stuck', mgr._vtxo(change.id).state === 'spent');
// The replacement's lifetime runs from the round, so it outlives the coin it
// replaced — by margin blocks less than a full term. (This test compresses a
// month into minutes, so the tip can already be past even the new expiry;
// what matters is that the claim reached a coin with a later clock.)
check('replacement carries a later expiry', !!rescued && rescued.expiryHeight > change.expiryHeight,
  rescued && `${change.expiryHeight} -> ${rescued.expiryHeight}`);
check('nothing left pending', mgr.balance().pendingSat === 0, JSON.stringify(mgr.balance()));

console.log(ok ? '\nALL GREEN\n' : '\nFAILURES\n');
process.exit(ok ? 0 : 1);
