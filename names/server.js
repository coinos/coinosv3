// BIP-353 name registrar for halwallet.app — gives every hal user a
// ₿name@halwallet.app payment address.
//
// Auth on every write is NIP-98 (HTTP Auth, kind 27235).
//
// A name is a DNSSEC-signed TXT record at
//   <name>.user._bitcoin-payment.halwallet.app
// whose content is a BIP-21 `bitcoin:` URI (for hal users: an ark address,
// extensible later with lno= etc). This service is the write path: it
// validates a claim signed by the wallet's nostr key, enforces first-come
// ownership by that key, and mirrors the record into Cloudflare DNS.
//
// WHAT THIS SERVICE LEARNS: name ↔ nostr pubkey ↔ payment URI. All of it is
// public by construction (DNS is public). It cannot spend anything.
//
// Deliberately dumb: one JSON state file, no accounts, no email.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyEvent, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { wrapManyEvents } from 'nostr-tools/nip17';
import { SimplePool } from 'nostr-tools/pool';
import { npubEncode } from 'nostr-tools/nip19';
import { createHash } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { lnBackend } from '../bridge/ln.js';
import { ArkManager } from '../src/ark/manager.js';
import { decodeAddress } from '../src/ark/proto.js';

const CFG = JSON.parse(readFileSync(process.env.NAMES_CONFIG
  || join(import.meta.dir, 'config.json'), 'utf8'));
// { port, domains: { '<domain>': { zoneId } }, domain (default), cfEmail, cfKey, stateFile,
//   ln: { kind:'socket', path } — the ASP's CLN, for per-name bolt12 offers,
//   forwarder: { mnemonic, ark, esplora, network } — a small float ark wallet
//     that forwards settled offer payments to the name's ark address }

const DOMAIN = CFG.domain || 'coinos.io'; // the default domain for claims
const PUBLIC_BASE = CFG.publicBase || 'https://names.coinos.io';
const DOMAINS = CFG.domains || { [DOMAIN]: { zoneId: CFG.zoneId } };
const STATE = CFG.stateFile || join(import.meta.dir, 'data', 'names.json');
const TTL = 300;                 // record TTL: BIP-353 wallets cache by this

const log = (...a) => console.log(new Date().toISOString(), ...a);

// names that must never be claimable
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'hal', 'halwallet', 'www', 'mail', 'help',
  'support', 'info', 'pay', 'payments', 'wallet', 'staging', 'names', 'api',
  'user', 'users', 'coinos', 'nostr', 'ark', 'test', 'dev', 'security', 'abuse',
]);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,29}$/;

let state = (() => {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { names: {} }; }
})();
function persist() {
  mkdirSync(dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE);
}

// ---------------------------------------------------------------------------
// Cloudflare DNS
// ---------------------------------------------------------------------------

const CF = 'https://api.cloudflare.com/client/v4';
const cfHeaders = {
  'X-Auth-Email': CFG.cfEmail, 'X-Auth-Key': CFG.cfKey, 'content-type': 'application/json',
};
const recordName = (name, domain) => `${name}.user._bitcoin-payment.${domain}`;

async function cfWrite(name, domain, uri, existingId) {
  // TXT character-strings cap at 255 bytes; BIP-353 readers concatenate the
  // chunks in order, so a long ark+lno URI just spans several quoted strings.
  const zoneId = DOMAINS[domain]?.zoneId;
  if (!zoneId) throw new Error('unknown domain');
  const chunks = uri.match(/.{1,255}/g).map((c) => `"${c}"`).join(' ');
  const body = JSON.stringify({
    type: 'TXT', name: recordName(name, domain), content: chunks, ttl: TTL,
  });
  const url = existingId
    ? `${CF}/zones/${zoneId}/dns_records/${existingId}`
    : `${CF}/zones/${zoneId}/dns_records`;
  const r = await fetch(url, { method: existingId ? 'PUT' : 'POST', headers: cfHeaders, body });
  const j = await r.json();
  if (!j.success) throw new Error('dns write failed: ' + JSON.stringify(j.errors).slice(0, 200));
  return j.result.id;
}
async function cfDelete(domain, recordId) {
  const zoneId = DOMAINS[domain]?.zoneId;
  if (!zoneId) throw new Error('unknown domain');
  const r = await fetch(`${CF}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE', headers: cfHeaders,
  });
  const j = await r.json();
  if (!j.success) throw new Error('dns delete failed');
}

// ---------------------------------------------------------------------------
// bolt12 offers + the settle forwarder
// ---------------------------------------------------------------------------
// Each name gets a static BOLT 12 offer on the ASP's CLN, published in the
// DNS record as lno=. Offer payments land on the ASP node, so a forwarder
// pushes each settled payment on to the name's ark address from a small
// float wallet (an ordinary arkoor send — free). Custody window: the seconds
// between LN settle and the ark send. The float must be topped up by the
// operator; LN income accrues on the node as the offset.

// ---------------------------------------------------------------------------
// LNURL-pay: the same address, payable by wallets that have never heard of
// DNS payment instructions (which is most of them).
//
// Two ways to produce the invoice, preferring the one that touches no funds:
//   1. ASK THE RECIPIENT. If their wallet published a CLINK offer key we send
//      it a kind-21001 request over nostr; their wallet (or its service
//      worker) mints an invoice against their own balance and we just hand it
//      back. Nothing passes through us.
//   2. MINT HERE. Otherwise our node issues the invoice and the settle
//      forwarder pushes the money on to their address, exactly like the
//      BOLT 12 offer path — custodial for the seconds in between.
const OFFER_KIND = 21001;
const LNURL_RELAYS = ['wss://relay.coinos.io', 'wss://relay.damus.io', 'wss://nos.lol'];
const pool = new SimplePool();

// Our own nostr identity: used to ask recipients for invoices, and to sign
// NIP-57 zap receipts for payments we mint ourselves.
if (!state.serviceSk) { state.serviceSk = Buffer.from(generateSecretKey()).toString('hex'); persist(); }
const SERVICE_SK = Uint8Array.from(Buffer.from(state.serviceSk, 'hex'));
const SERVICE_PK = getPublicKey(SERVICE_SK);

// ---------------------------------------------------------------------------
// Welcome DM — every first-time registrant gets a NIP-17 DM from Adam.
// config: welcome: { sk: '<hex privkey>', message: '…' }. The registration is
// the one moment we reliably know a new user's npub, so it doubles as the
// "new user" signal. One per pubkey, ever (state.welcomed).
// ---------------------------------------------------------------------------

const WELCOME = CFG.welcome && /^[0-9a-f]{64}$/.test(CFG.welcome.sk || '') ? {
  sk: Uint8Array.from(Buffer.from(CFG.welcome.sk, 'hex')),
  message: CFG.welcome.message || 'Welcome to coinos!',
} : null;

async function inboxRelaysOf(pubkey) {
  try {
    const evs = await pool.querySync(LNURL_RELAYS, { kinds: [10002, 10050], authors: [pubkey] }, { maxWait: 4000 });
    const newest = (kind) => evs.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0];
    const dm = newest(10050);
    if (dm) { const r = dm.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]); if (r.length) return r.slice(0, 4); }
    const rl = newest(10002);
    if (rl) return rl.tags.filter((t) => t[0] === 'r' && (!t[2] || t[2] === 'read')).map((t) => t[1]).slice(0, 4);
  } catch {}
  return [];
}

async function sendWelcome(pubkey) {
  if (!WELCOME) return;
  state.welcomed ||= {};
  if (state.welcomed[pubkey]) return;
  state.welcomed[pubkey] = Date.now();
  persist();
  try {
    // wrapManyEvents returns [sender-copy, recipient] — publish ONLY the
    // recipient's wrap. A sender copy per registrant flooded Adam's own
    // clients with an endless stream of his own welcome message.
    const [, toPeer] = wrapManyEvents(WELCOME.sk, [{ publicKey: pubkey }], WELCOME.message);
    const inbox = await inboxRelaysOf(pubkey);
    await Promise.allSettled(pool.publish([...new Set([...inbox, ...LNURL_RELAYS])], toPeer));
    log(`welcome DM sent to ${pubkey.slice(0, 12)}`);
  } catch (e) {
    log('welcome DM failed: ' + e.message);
  }
}

const lnurlMeta = (address) => JSON.stringify([
  ['text/plain', `Paying ${address}`],
  ['text/identifier', address],
]);

// Ask the recipient's own wallet for an invoice (CLINK offer, kind 21001).
function requestInvoiceFromWallet(offerPk, { amountSat, description, zap }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sub.close(); } catch {} resolve(v); } };
    const key = nip44.getConversationKey(SERVICE_SK, offerPk);
    const payload = { offer: 'zap_default', amount_sats: amountSat };
    if (description) payload.description = description.slice(0, 100);
    if (zap) payload.zap = zap;
    const req = finalizeEvent({
      kind: OFFER_KIND, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', offerPk], ['clink_version', '1']],
      content: nip44.encrypt(JSON.stringify(payload), key),
    }, SERVICE_SK);
    const sub = pool.subscribeMany(LNURL_RELAYS,
      { kinds: [OFFER_KIND], '#e': [req.id], since: Math.floor(Date.now() / 1000) - 5 },
      {
        onevent: (ev) => {
          try {
            const body = JSON.parse(nip44.decrypt(ev.content, key));
            if (body.bolt11) return finish(body.bolt11);
          } catch {}
        },
      });
    Promise.allSettled(pool.publish(LNURL_RELAYS, req)).catch(() => {});
    setTimeout(() => finish(null), 6000); // wallets that aren't listening
  });
}

const ln = CFG.ln ? lnBackend(CFG.ln) : null;
// Optional mutinynet CLN — lets staging sell (play-money) hats. Nothing else
// uses it: names, offers and forwards remain mainnet affairs.
const lnMut = CFG.lnMut ? lnBackend(CFG.lnMut) : null;

// -- routing-fee quotes (the /lnquote endpoint) ------------------------------

// Ark locks are sat-granular and the locked surplus IS xpay's maxfee, which
// binds hard — a 9 msat route under a 0 budget fails outright (verified live:
// "Could not find route without excessive cost", then the +1-sat retry paid).
// So sub-sat fees round UP: the honest minimum a client can bring is 1 sat.
// Making those truly free needs the ASP to bring the msats itself (captaind
// patch: floor max_routing_fee at 1 sat), not a rounder-down here.
const quoteSat = (msat) => Math.ceil(msat / 1000);

let _ourNodeId = null;
async function ourNodeId() {
  if (!_ourNodeId) _ourNodeId = (await ln.call('getinfo')).id;
  return _ourNodeId;
}

// Ask askrene (the router xpay itself uses) what delivering amountMsat to
// dest would cost from here. The maxfee passed in is only the SEARCH cap —
// generous on purpose, since the user sees and approves the quoted fee
// before anything is locked.
async function routeFeeMsat(our, dest, amountMsat, finalCltv) {
  const cap = Math.max(50_000, Math.ceil(amountMsat * 0.05));
  const r = await ln.call('getroutes', {
    source: our, destination: dest, amount_msat: amountMsat,
    // localchans FIRST: it re-adds our channels with their advertised fees,
    // so sourcefree must come after it to zero our own hops (verified live —
    // the other order quotes 1 sat on a direct-peer payment).
    layers: ['auto.localchans', 'auto.sourcefree'],
    maxfee_msat: cap, final_cltv: finalCltv,
  });
  if (!r.routes || !r.routes.length) throw new Error('no route found');
  const sent = r.routes.reduce((s, rt) => s + Number(rt.path[0].amount_msat), 0);
  const delivered = r.routes.reduce((s, rt) => s + Number(rt.amount_msat), 0);
  return Math.max(0, sent - delivered);
}
let fwd = null; // the float ark wallet
if (CFG.forwarder?.mnemonic) {
  const account = HDKey.fromMasterSeed(mnemonicToSeedSync(CFG.forwarder.mnemonic)).derive("m/86'/0'/9'");
  fwd = await new ArkManager({
    account,
    storage: {
      load: () => state.fwdArk || null,
      save: (s) => { state.fwdArk = s; persist(); },
    },
    arkUrl: CFG.forwarder.ark, esploraUrl: CFG.forwarder.esplora, network: CFG.forwarder.network || 'mainnet',
  }).init();
  // Read the mailbox before reporting: a top-up sent while we were down (or
  // between syncs) lives there, and balance() only counts what state has seen.
  await fwd.sync().catch(() => {});
  log(`forwarder ark wallet ready — float ${fwd.balance().spendableSat} sat, receive ${fwd.address().slice(0, 24)}…`);
}

async function makeOffer(address) { // "name@domain"
  if (!ln) return null;
  const o = await ln.call('offer', { amount: 'any', description: address });
  return { offerId: o.offer_id, bolt12: o.bolt12 };
}

const arkParamOf = (uri) => {
  const m = String(uri).match(/[?&]ark=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

// Deliver a settled payment to the name's owner. Two ways, and we try the
// one that works while they're asleep first:
//   1. an arkoor send from the float — instant, free, needs no cooperation
//   2. ask their wallet for an invoice and pay it over Lightning — needs no
//      float at all, but only works while something of theirs is listening
// Failing both, it queues and retries; nothing is ever dropped silently.
async function forward(name, sat) {
  const rec = state.names[name];
  const dest = rec && arkParamOf(rec.uri);
  if (!dest && !rec?.offerPk) { log(`forward: nowhere to send ${sat} sat for ${name}`); return; }

  if (dest && fwd && fwd.balance().spendableSat >= sat) {
    await fwd.send(dest, sat);
    log(`forwarded ${sat} sat to ${name}`);
    return;
  }

  if (rec?.offerPk && ln) {
    const pr = await requestInvoiceFromWallet(rec.offerPk, { amountSat: sat, description: `${name} payment` });
    if (pr) {
      await ln.pay(pr, { maxfeeSat: Math.max(2, Math.ceil(sat * 0.005)) });
      log(`delivered ${sat} sat to ${name} over lightning (no float needed)`);
      return;
    }
  }
  throw new Error(fwd && dest ? 'insufficient float and the wallet is not listening' : 'no delivery route');
}

// NIP-57: a zap we invoiced is only "a zap" once we publish the receipt,
// signed by the key our LNURL response advertises.
async function publishZapReceipt(pending, inv) {
  try {
    const zapReq = JSON.parse(pending.zap);
    const tags = [
      ...zapReq.tags.filter((t) => t[0] === 'p' || t[0] === 'e' || t[0] === 'a'),
      ['P', zapReq.pubkey],
      ['bolt11', pending.bolt11],
      ['description', pending.zap],
    ];
    if (inv.payment_preimage) tags.push(['preimage', inv.payment_preimage]);
    const receipt = finalizeEvent({ kind: 9735, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, SERVICE_SK);
    const relayTag = zapReq.tags.find((t) => t[0] === 'relays');
    const relays = [...new Set([...(relayTag ? relayTag.slice(1) : []), ...LNURL_RELAYS])].slice(0, 8);
    await Promise.allSettled(pool.publish(relays, receipt));
    log(`published a zap receipt for ${pending.key}`);
  } catch (e) { log('zap receipt failed: ' + e.message); }
}

// ---------------------------------------------------------------------------
// Hats — cosmetic supporter hats, shown above the buyer's avatar in coinos.
// Ownership is a paid CLN invoice; the registry here is what clients trust
// (a kind-0 field would be self-asserted). Money stays on the node: it IS
// the support. The crown is Adam's and is not for sale.
// ---------------------------------------------------------------------------

const HAT_ADMIN_PK = '98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7';
const HAT_PRICES = {
  beanie: 21, party: 2100, trucker: 2100, cowboy: 21000, fedora: 21000,
  bowler: 210000, top: 210000, wizard: 2100000,
};

// Mutinynet runs a parallel hat economy (invoices minted on the mutinynet
// CLN, grants in their own registry) so play-money purchases can exercise
// the whole flow on staging without ever buying a hat mainnet users see.
const hatNetOf = (v) => (v === 'mutinynet' ? 'mutinynet' : 'mainnet');
const hatStore = (net) => (net === 'mutinynet' ? (state.hatsMut ||= {}) : (state.hats ||= {}));
const hatLn = (net) => (net === 'mutinynet' ? lnMut : ln);

function hatRec(pk, net = 'mainnet') {
  const r = hatStore(net)[pk];
  const owned = r ? [...(r.owned || [])] : [];
  if (pk === HAT_ADMIN_PK && !owned.includes('crown')) owned.push('crown');
  const equipped = r ? (r.equipped || null) : (pk === HAT_ADMIN_PK ? 'crown' : null);
  return { owned, equipped };
}

function grantHat(pk, hat, net = 'mainnet') {
  const r = hatStore(net)[pk] ||= { owned: [], equipped: null };
  if (!r.owned.includes(hat)) r.owned.push(hat);
  r.equipped = hat; // a fresh purchase goes straight on the head
}

async function settleLoop() {
  if (!ln || !fwd) return;
  state.lastPayIndex = state.lastPayIndex || 0;
  for (;;) {
    let inv;
    try {
      inv = await ln.call('waitanyinvoice', { lastpay_index: state.lastPayIndex, timeout: 120 });
    } catch (e) {
      if (!/timed out|Timed out/i.test(e.message)) await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    state.lastPayIndex = inv.pay_index || state.lastPayIndex;
    persist();
    // hat purchases settle here too — grant and keep the sats (that's the point)
    const hatPending = state.hatInvoices && state.hatInvoices[inv.payment_hash];
    if (hatPending) {
      grantHat(hatPending.pubkey, hatPending.hat, hatNetOf(hatPending.net));
      delete state.hatInvoices[inv.payment_hash];
      persist();
      log(`hat sold: ${hatPending.hat} (${hatNetOf(hatPending.net)}) to ${hatPending.pubkey.slice(0, 12)}`);
      continue;
    }
    const offerId = inv.local_offer_id;
    let name = offerId && Object.keys(state.names).find((n) => state.names[n].offerId === offerId);
    // custom offers (a memo'd bolt12 the user minted for e.g. a mining pool)
    if (!name && offerId && state.offers && state.offers[offerId]) name = state.offers[offerId].key;
    // LNURL invoices we minted: recorded against their payment hash
    const pending = state.invoices && state.invoices[inv.payment_hash];
    if (!name && pending) name = pending.key;
    if (!name) {
      // Usually genuinely not ours (the ASP's and boltz's invoices settle on
      // this node too) — but log it, so a lost mapping is an audit-grep away
      // instead of an archaeology project.
      log(`settle without a name: ${inv.payment_hash} ${inv.amount_received_msat || ''}`);
      continue;
    }
    const sat = Math.floor((inv.amount_received_msat?.msat ?? inv.amount_received_msat ?? 0) / 1000);
    if (!sat) continue;
    // money has arrived for this name — push-notify their devices (best effort)
    if (CFG.push && CFG.push.url && state.names[name]) {
      fetch(`${CFG.push.url}/notify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: CFG.push.token, pubkey: state.names[name].pubkey, amountSat: sat }),
      }).catch(() => {});
    }
    if (pending) {
      if (pending.zap) publishZapReceipt(pending, inv).catch(() => {});
      delete state.invoices[inv.payment_hash];
      persist();
    }
    try {
      await forward(name, sat);
    } catch (e) {
      log(`forward failed for ${name} (${sat} sat): ${e.message} — queued`);
      state.pending = state.pending || [];
      state.pending.push({ name, sat, ts: Date.now() });
      persist();
    }
  }
}
// retry queued forwards (e.g. after the float is topped up). Each failure
// backs off exponentially (1m → 1h cap): a stuck forward must not fire an
// offer request — and push-wake the recipient's devices — every minute
// forever.
setInterval(async () => {
  const q = state.pending || [];
  if (!q.length || !fwd) return;
  // a float top-up arrives as ark mail; without this the queue would keep
  // failing on a balance that's already been refilled
  await fwd.sync().catch(() => {});
  const still = [];
  for (const p of q) {
    if (p.next && Date.now() < p.next) { still.push(p); continue; }
    try { await forward(p.name, p.sat); }
    catch (e) {
      log(`forward retry failed for ${p.name} (${p.sat} sat, try ${(p.tries || 0) + 1}): ${e.message}`);
      p.tries = (p.tries || 0) + 1;
      p.next = Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(p.tries - 1, 6));
      still.push(p);
    }
  }
  state.pending = still;
  persist();
}, 60_000);

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

// NIP-98 HTTP Auth (kind 27235). The signature covers this exact URL, method
// and body hash, so a captured header is useless anywhere else.
async function checkNip98(req, url, bodyText) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Nostr\s+(.+)$/i);
  if (!m) return { error: 'missing Nostr authorization' };
  let evt;
  try { evt = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return { error: 'bad auth encoding' }; }
  if (evt.kind !== 27235) return { error: 'auth must be kind 27235' };
  if (Math.abs(Date.now() / 1000 - (evt.created_at || 0)) > 60) return { error: 'auth event expired' };
  if (!verifyEvent(evt)) return { error: 'bad signature' };
  const tag = (k) => (evt.tags.find((x) => x[0] === k) || [])[1];
  if ((tag('method') || '').toUpperCase() !== req.method) return { error: 'method mismatch' };
  let got;
  try { got = new URL(tag('u') || ''); } catch { return { error: 'bad url tag' }; }
  if (got.pathname !== url.pathname) return { error: 'url mismatch' };
  if (bodyText) {
    const want = createHash('sha256').update(bodyText).digest('hex');
    if (tag('payload') !== want) return { error: 'payload hash mismatch' };
  }
  return { pubkey: evt.pubkey };
}

// npub-prefix names are the free default everyone gets, so they must not be
// squattable: a name that looks like one may only be claimed by that very
// identity — or by a key that identity nominated as its manager (the wallet
// key, which is always available, even offline and in the service worker).
const npubPrefixOwner = (name) => (/^npub1[a-z0-9]+$/.test(name) ? name : null);

// coinos.io names that belong to existing coinos users are reserved for
// them until the migration gives those users a way to claim their own.
async function takenByCoinosUser(domain, name) {
  if (domain !== 'coinos.io') return false;
  try {
    const r = await fetch(`https://coinos.io/api/users/${encodeURIComponent(name)}`);
    if (r.status !== 200) return false;
    // A migrated account has handed its name over: the old site keeps the
    // account and its history, but receiving belongs to us now.
    const u = await r.json().catch(() => null);
    return !(u && u.migrated);
  } catch { return true; } // can't verify → refuse rather than squat
}

const validUri = (u) => typeof u === 'string' && /^bitcoin:/i.test(u) && u.length <= 480
  && !/[\s"\\]/.test(u);

// crude per-IP limiter
const rate = new Map();
function rateOk(ip, limit = 10) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter((t) => t > now - 60_000);
  if (arr.length >= limit) return false;
  arr.push(now);
  rate.set(ip, arr);
  if (rate.size > 1000) for (const [k, v] of rate) { if (!v.some((t) => t > now - 60_000)) rate.delete(k); }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const json = (body, status = 200) => {
  if (status >= 400) log(`→ ${status} ${JSON.stringify(body).slice(0, 120)}`);
  return new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  },
  });
};

Bun.serve({
  port: CFG.port || 8798,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return json({});
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';

    if (url.pathname === '/health') {
      return json({
        ok: true, domain: DOMAIN, names: Object.keys(state.names).length,
        offers: !!ln, floatSat: fwd ? fwd.balance().spendableSat : null,
        floatAddress: fwd ? fwd.address() : null,
        pendingForwards: (state.pending || []).length,
      });
    }

    // Routing-fee quote for an outgoing lightning payment. The wallet locks
    // amount + this fee into its HTLC and the ASP hands the whole surplus to
    // CLN as the routing budget, so the number returned here is exactly what
    // the user pays — zero for invoices minted on our own node (every
    // coinos-to-coinos payment) and for direct peers. Informational only:
    // a wrong quote fails the payment (refunded in full) or overpays a route,
    // it can never spend more than the user chose to lock.
    if (url.pathname === '/lnquote' && req.method === 'GET') {
      if (!ln) return json({ error: 'no lightning backend' }, 503);
      if (!rateOk(ip, 30)) return json({ error: 'rate limited' }, 429);
      try {
        const invoice = (url.searchParams.get('invoice') || '').trim().toLowerCase();
        if (!invoice || invoice.length > 4000) return json({ error: 'invoice required' }, 400);
        const dec = await ln.call('decode', { string: invoice });
        if (dec.valid === false) return json({ error: 'invalid invoice' }, 400);
        const dest = dec.payee || dec.invoice_node_id;
        const amountMsat = Math.floor(Number(url.searchParams.get('amount_msat')) || 0)
          || Number(dec.amount_msat || dec.invoice_amount_msat || 0);
        if (!dest) return json({ error: 'no destination in invoice' }, 400);
        if (!amountMsat || amountMsat < 0) return json({ error: 'amount required' }, 400);
        const our = await ourNodeId();
        if (dest === our) return json({ feeMsat: 0, feeSat: 0, direct: true });
        const finalCltv = dec.min_final_cltv_expiry || 18;
        try {
          const feeMsat = await routeFeeMsat(our, dest, amountMsat, finalCltv);
          return json({ feeMsat, feeSat: quoteSat(feeMsat), direct: false });
        } catch (e) {
          // Private recipient: not in gossip, reachable only via the
          // invoice's route hints. Quote = route to the hint's public entry
          // node + the hint hops' advertised fees.
          const hint = (dec.routes || [])[0];
          if (!hint || !hint.length) throw e;
          let hintFeeMsat = 0;
          let carried = amountMsat;
          for (const hop of [...hint].reverse()) {
            const f = (hop.fee_base_msat || 0) + Math.ceil(carried * (hop.fee_proportional_millionths || 0) / 1_000_000);
            hintFeeMsat += f; carried += f;
          }
          const entry = hint[0].pubkey;
          const toEntry = entry === our ? 0
            : await routeFeeMsat(our, entry, amountMsat + hintFeeMsat, finalCltv);
          const feeMsat = toEntry + hintFeeMsat;
          return json({ feeMsat, feeSat: quoteSat(feeMsat), direct: false, hinted: true });
        }
      } catch (e) {
        return json({ error: e.message || 'no route found' }, 404);
      }
    }

    // Prefix search over registered names — powers recipient search in the
    // wallet's DMs. Public data (every name is a public DNS record).
    if (url.pathname === '/search' && req.method === 'GET') {
      if (!rateOk(ip, 60)) return json({ error: 'rate limited' }, 429);
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      if (q.length < 2 || q.length > 30) return json({ results: [] });
      const results = Object.entries(state.names)
        .filter(([key]) => key.split('@')[0].startsWith(q))
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
        .slice(0, 10)
        .map(([key, r]) => ({ address: key, name: key.split('@')[0], pubkey: r.pubkey }));
      return json({ results });
    }

    // A user's own BOLT 12 offers with a custom memo — what a mining pool or
    // payroll wants to send to. Settled payments ride the same forwarder as
    // the name's default offer, so they land in the user's Spending balance.
    if (url.pathname === '/offer' && (req.method === 'POST' || req.method === 'GET')) {
      if (!rateOk(ip)) return json({ error: 'rate limited' }, 429);
      const bodyText = req.method === 'POST' ? await req.text() : '';
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      const key = Object.keys(state.names)
        .find((k) => state.names[k].pubkey === a.pubkey || state.names[k].manager === a.pubkey);
      if (!key) return json({ error: 'claim a name first' }, 400);
      state.offers = state.offers || {};
      if (req.method === 'GET') {
        return json({ offers: Object.entries(state.offers)
          .filter(([, o]) => o.key === key)
          .map(([offerId, o]) => ({ offerId, memo: o.memo, bolt12: o.bolt12, created: o.created })) });
      }
      if (!ln) return json({ error: 'offers unavailable' }, 503);
      let body;
      try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const memo = String(body.memo || '').slice(0, 120).trim();
      const mine = Object.entries(state.offers).filter(([, o]) => o.key === key);
      const dup = mine.find(([, o]) => o.memo === memo);
      if (dup) return json({ ok: true, offerId: dup[0], memo, bolt12: dup[1].bolt12, existing: true });
      if (mine.length >= 10) return json({ error: 'too many offers' }, 400);
      let o;
      try {
        // `issuer` keeps two users' identical memos from collapsing onto one
        // CLN offer (it dedupes by the offer's contents).
        o = await ln.call('offer', { amount: 'any', description: memo || key, issuer: key });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
      state.offers[o.offer_id] = { key, memo, bolt12: o.bolt12, created: Date.now() };
      persist();
      log(`offer for ${key}: ${memo ? JSON.stringify(memo) : '(no memo)'}`);
      return json({ ok: true, offerId: o.offer_id, memo, bolt12: o.bolt12 });
    }

    // --- NIP-05 --------------------------------------------------------
    // Every claimed name doubles as a nostr identifier: name@domain verifies
    // against the owner's key. Public data, CORS comes with json().
    if ((url.pathname === '/.well-known/nostr.json' || url.pathname === '/nostr.json') && req.method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase();
      const domain = (url.searchParams.get('domain') || DOMAIN).toLowerCase();
      if (!NAME_RE.test(name)) return json({ names: {} });
      const rec = state.names[`${name}@${domain}`];
      return json(rec ? { names: { [name]: rec.pubkey } } : { names: {} });
    }

    // Availability / lookup. Public data (it's DNS).
    const m = url.pathname.match(/^\/name\/([a-z0-9._-]{1,30})$/);
    if (m && req.method === 'GET') {
      const domain = (url.searchParams.get('domain') || DOMAIN).toLowerCase();
      const rec = state.names[`${m[1]}@${domain}`];
      if (rec) return json({ name: m[1], domain, taken: true, pubkey: rec.pubkey, uri: rec.uri });
      const reserved = RESERVED.has(m[1]) || !NAME_RE.test(m[1]) || await takenByCoinosUser(domain, m[1]);
      return json({ name: m[1], domain, taken: reserved, reserved });
    }

    // Which name(s) does a wallet key own? Lets an imported seed find its
    // username again without the user retyping it. Public data (DNS is public).
    const pm = url.pathname.match(/^\/pubkey\/([0-9a-f]{64})$/);
    if (pm && req.method === 'GET') {
      // optional domain filter, so a staging claim can't shadow a mainnet
      // name (or vice versa) when a wallet asks who it is
      const domFilter = (url.searchParams.get('domain') || '').toLowerCase();
      const mine = Object.entries(state.names)
        .filter(([k, r]) => r.pubkey === pm[1] && (!domFilter || k.endsWith('@' + domFilter)))
        .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
      if (!mine.length) return json({});
      const [key, r] = mine[0];
      const [name, domain] = key.split('@');
      return json({ name, domain, uri: r.uri });
    }

    // --- hats ------------------------------------------------------------

    // Batched display lookup: which hat is each of these heads wearing?
    // Public data (a hat is worn in public by construction).
    if (url.pathname === '/hats' && req.method === 'GET') {
      const net = hatNetOf(url.searchParams.get('net'));
      const pks = (url.searchParams.get('pks') || '')
        .split(',').filter((p) => /^[0-9a-f]{64}$/.test(p)).slice(0, 100);
      const hats = {};
      for (const pk of pks) hats[pk] = hatRec(pk, net).equipped;
      return json({ hats });
    }

    // The shop view: everything one pubkey owns, plus the price list (the
    // client shows what the server would actually charge).
    const hm = url.pathname.match(/^\/hats\/([0-9a-f]{64})$/);
    if (hm && req.method === 'GET') {
      return json({ ...hatRec(hm[1], hatNetOf(url.searchParams.get('net'))), prices: HAT_PRICES });
    }

    if (url.pathname === '/hats/invoice' && req.method === 'POST') {
      if (!rateOk(ip)) return json({ error: 'rate limited' }, 429);
      const bodyText = await req.text();
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      let body;
      try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const hat = String(body.hat || '');
      const net = hatNetOf(body.net);
      const sat = HAT_PRICES[hat];
      if (!sat) return json({ error: 'no such hat' }, 400);
      if (hatRec(a.pubkey, net).owned.includes(hat)) return json({ error: 'you already own that hat' }, 400);
      const node = hatLn(net);
      if (!node) return json({ error: 'the hat stand is closed right now' }, 503);
      try {
        const inv = await node.call('invoice', {
          amount_msat: sat * 1000,
          label: `hat-${hat}-${a.pubkey.slice(0, 8)}-${Date.now()}`,
          description: `coinos hat: ${hat}`,
          expiry: 900,
        });
        state.hatInvoices ||= {};
        state.hatInvoices[inv.payment_hash] = { pubkey: a.pubkey, hat, sat, net, ts: Date.now() };
        for (const [h2, v] of Object.entries(state.hatInvoices)) {
          if (Date.now() - v.ts > 7 * 86400_000) delete state.hatInvoices[h2];
        }
        persist();
        log(`hat invoice: ${hat} (${sat} sat, ${net}) for ${a.pubkey.slice(0, 12)}`);
        return json({ invoice: inv.bolt11, paymentHash: inv.payment_hash, sat });
      } catch (e) {
        log('hat invoice failed: ' + e.message);
        return json({ error: 'could not create an invoice' }, 500);
      }
    }

    // The buyer pings us right after paying, so the hat appears without
    // waiting on the settle loop. Idempotent with it: whoever runs first
    // grants, the other finds it done.
    if (url.pathname === '/hats/claim' && req.method === 'POST') {
      const bodyText = await req.text();
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      let body;
      try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const hash = String(body.paymentHash || '');
      const hat = String(body.hat || '');
      const net = hatNetOf(body.net);
      const pending = (state.hatInvoices || {})[hash];
      if (!pending) {
        // the settle loop may have beaten us to it
        if (hat && hatRec(a.pubkey, net).owned.includes(hat)) return json(hatRec(a.pubkey, net));
        return json({ error: 'unknown invoice' }, 404);
      }
      if (pending.pubkey !== a.pubkey) return json({ error: 'not your invoice' }, 403);
      const node = hatLn(hatNetOf(pending.net));
      if (!node) return json({ error: 'the hat stand is closed right now' }, 503);
      try {
        const r = await node.call('listinvoices', { payment_hash: hash });
        if ((r.invoices || [])[0]?.status !== 'paid') return json({ error: 'invoice not paid yet' }, 402);
      } catch (e) {
        return json({ error: 'could not check the invoice' }, 500);
      }
      grantHat(pending.pubkey, pending.hat, hatNetOf(pending.net));
      delete state.hatInvoices[hash];
      persist();
      log(`hat sold (claim): ${pending.hat} (${hatNetOf(pending.net)}) to ${pending.pubkey.slice(0, 12)}`);
      return json(hatRec(a.pubkey, hatNetOf(pending.net)));
    }

    if (url.pathname === '/hats/equip' && req.method === 'POST') {
      const bodyText = await req.text();
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      let body;
      try { body = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const hat = body.hat ? String(body.hat) : null;
      const net = hatNetOf(body.net);
      if (hat && !hatRec(a.pubkey, net).owned.includes(hat)) return json({ error: 'you do not own that hat' }, 403);
      const r = hatStore(net)[a.pubkey] ||= { owned: [], equipped: null };
      r.equipped = hat;
      persist();
      return json(hatRec(a.pubkey, net));
    }

    // --- LNURL-pay (LUD-06/16, NIP-57 zaps) ------------------------------
    const lm = url.pathname.match(/^\/(?:\.well-known\/lnurlp|lnurlp)\/([a-z0-9._-]{1,30})$/i);
    if (lm && req.method === 'GET') {
      const name = lm[1].toLowerCase();
      const domain = (url.searchParams.get('domain') || DOMAIN).toLowerCase();
      const rec = state.names[`${name}@${domain}`];
      if (!rec) return json({ status: 'ERROR', reason: 'unknown address' }, 404);
      const address = `${name}@${domain}`;
      return json({
        tag: 'payRequest',
        callback: `${PUBLIC_BASE}/lnurlp/${name}/cb?domain=${encodeURIComponent(domain)}`,
        minSendable: 1000,
        maxSendable: 500000000,
        metadata: lnurlMeta(address),
        commentAllowed: 200,
        allowsNostr: true,
        nostrPubkey: SERVICE_PK,
      });
    }

    const cb = url.pathname.match(/^\/lnurlp\/([a-z0-9._-]{1,30})\/cb$/i);
    if (cb && req.method === 'GET') {
      const name = cb[1].toLowerCase();
      const domain = (url.searchParams.get('domain') || DOMAIN).toLowerCase();
      const key = `${name}@${domain}`;
      const rec = state.names[key];
      if (!rec) return json({ status: 'ERROR', reason: 'unknown address' }, 404);
      const msat = parseInt(url.searchParams.get('amount') || '0', 10);
      if (!msat || msat < 1000) return json({ status: 'ERROR', reason: 'amount too small' }, 400);
      const sat = Math.floor(msat / 1000);
      const zap = url.searchParams.get('nostr') || null;
      const comment = (url.searchParams.get('comment') || '').slice(0, 200);

      // 1. the recipient's own wallet, if it is listening
      if (rec.offerPk) {
        const pr = await requestInvoiceFromWallet(rec.offerPk, { amountSat: sat, description: comment, zap });
        if (pr) { log(`lnurl ${key}: recipient minted ${sat} sat`); return json({ pr, routes: [] }); }
      }
      // Staging names are mutinynet wallets: only their own wallet can mint a
      // right-network invoice. Minting on our mainnet node would take real
      // sats for play money and strand them (the forwarder can't deliver to
      // a testnet ark address).
      if (domain === 'staging.coinos.io') return json({ status: 'ERROR', reason: 'recipient is offline' }, 503);
      // 2. our node, forwarded on settle
      if (!ln || !fwd) return json({ status: 'ERROR', reason: 'recipient is offline' }, 503);
      try {
        const description = zap || lnurlMeta(key);
        const inv = await ln.call('invoice', {
          amount_msat: msat,
          label: `lnurl-${key}-${Date.now()}`,
          description,
          deschashonly: true, // LUD-06: the invoice carries sha256(metadata)
          expiry: 900,
        });
        state.invoices = state.invoices || {};
        state.invoices[inv.payment_hash] = { key, zap, bolt11: inv.bolt11, ts: Date.now() };
        // forget invoices nobody paid
        // Keep mappings as long as the invoice could possibly settle: a 1h
        // sweep once erased a mapping while the settle loop was catching up
        // after downtime, stranding a paid 1000 sats unattributed (found
        // again only via the description_hash). CLN invoices default to a
        // 7-day expiry — match it.
        for (const [h, v] of Object.entries(state.invoices)) {
          if (Date.now() - v.ts > 7 * 86400_000) delete state.invoices[h];
        }
        persist();
        log(`lnurl ${key}: issued ${sat} sat (forwarding on settle)`);
        return json({ pr: inv.bolt11, routes: [] });
      } catch (e) {
        log('lnurl invoice failed: ' + e.message);
        return json({ status: 'ERROR', reason: 'could not create an invoice' }, 500);
      }
    }

    // Top up the float over Lightning: it mints an invoice against its own
    // ark balance, which anyone (in practice, the operator's node) can pay.
    // Guarded by a token from the config file — this endpoint is public.
    if (url.pathname === '/admin/topup' && req.method === 'POST') {
      if (!CFG.adminToken || req.headers.get('x-admin-token') !== CFG.adminToken) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!fwd) return json({ error: 'no forwarder wallet' }, 503);
      const body = await req.json().catch(() => ({}));
      const sat = Math.floor(body.sat || 0);
      if (!sat || sat < 1000) return json({ error: 'amount too small' }, 400);
      try {
        const a = await fwd.createLnInvoice(sat, 'names float top-up');
        log(`float top-up invoice for ${sat} sat`);
        return json({ invoice: a.invoice, paymentHash: a.paymentHash });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Drive an in-flight lightning receive forward (top-ups settle async).
    if (url.pathname === '/admin/drive' && req.method === 'POST') {
      if (!CFG.adminToken || req.headers.get('x-admin-token') !== CFG.adminToken) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!fwd) return json({ error: 'no forwarder wallet' }, 503);
      for (const a of fwd.pendingActions()) { await fwd.driveLn(a.id).catch(() => {}); }
      await fwd.sync().catch(() => {});
      return json({ ok: true, floatSat: fwd.balance().spendableSat });
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      if (!rateOk(ip)) return json({ error: 'rate limited' }, 429);
      const bodyText = await req.text();
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      let claim;
      try { claim = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const auth = { pubkey: a.pubkey };
      const name = String(claim.name || '').toLowerCase();
      const domain = String(claim.domain || 'halwallet.app').toLowerCase();
      if (!DOMAINS[domain]) return json({ error: 'unknown domain' }, 400);
      if (!NAME_RE.test(name)) return json({ error: 'invalid name (a-z, 0-9, . _ -, max 30)' }, 400);
      if (RESERVED.has(name)) return json({ error: 'name is reserved' }, 400);
      if (!validUri(claim.uri)) return json({ error: 'uri must be a bitcoin: URI' }, 400);

      const key = `${name}@${domain}`;
      const existing = state.names[key];
      // owner OR the manager key the owner nominated may update a record
      if (existing && existing.pubkey !== auth.pubkey && existing.manager !== auth.pubkey) {
        return json({ error: 'name is taken' }, 409);
      }
      if (!existing && await takenByCoinosUser(domain, name)) return json({ error: 'name is taken' }, 409);
      // an npub-shaped name belongs to that identity alone
      if (npubPrefixOwner(name)) {
        const managerOk = existing && existing.manager === auth.pubkey;
        if (!npubEncode(auth.pubkey).startsWith(name) && !managerOk) {
          return json({ error: 'that name belongs to another Nostr identity' }, 403);
        }
      }
      if (/[?&]lno=/.test(claim.uri)) return json({ error: 'lno is added by the registrar' }, 400);
      // A corrupt ark address recorded here is a payment black hole: forwards
      // fail forever while the sats sit on the node (goyslop's 190k sat sat
      // behind an invalid checksum). Refuse it at the door.
      const arkDest = arkParamOf(claim.uri);
      if (arkDest) {
        try { decodeAddress(arkDest); }
        catch { return json({ error: 'the ark address in the uri does not decode' }, 400); }
      }

      // Every name also gets a static Lightning offer on our node; payments
      // to it are forwarded to the ark destination in the claim.
      let offer = existing?.offerId ? { offerId: existing.offerId, bolt12: existing.bolt12 } : null;
      if (!offer) { try { offer = await makeOffer(key); } catch (e) { log('offer creation failed: ' + e.message); } }
      const published = offer ? `${claim.uri}${claim.uri.includes('?') ? '&' : '?'}lno=${offer.bolt12}` : claim.uri;

      const recordId = await cfWrite(name, domain, published, existing?.recordId);
      state.names[key] = {
        pubkey: existing?.pubkey || auth.pubkey,
        // the owner may nominate a key that manages the record from here on
        manager: (claim.manager && /^[0-9a-f]{64}$/.test(claim.manager) && auth.pubkey !== claim.manager)
          ? claim.manager : existing?.manager,
        uri: published, recordId, updated: Date.now(), domain,
        // the wallet's CLINK offer key, so LNURL can ask it for invoices
        offerPk: (claim.offerPk && /^[0-9a-f]{64}$/.test(claim.offerPk)) ? claim.offerPk : existing?.offerPk,
        offerId: offer?.offerId, bolt12: offer?.bolt12,
      };
      persist();
      log(`${existing ? 'updated' : 'registered'} ${key} for ${auth.pubkey.slice(0, 12)}`);
      if (!existing) sendWelcome(state.names[key].pubkey).catch(() => {});
      return json({ ok: true, name, address: key, record: recordName(name, domain) });
    }

    if (url.pathname === '/register' && req.method === 'DELETE') {
      if (!rateOk(ip)) return json({ error: 'rate limited' }, 429);
      const bodyText = await req.text();
      const a = await checkNip98(req, url, bodyText);
      if (a.error) return json({ error: a.error }, 401);
      let claim;
      try { claim = JSON.parse(bodyText); } catch { return json({ error: 'bad body' }, 400); }
      const auth = { pubkey: a.pubkey };
      const name = String(claim.name || '').toLowerCase();
      const domain = String(claim.domain || 'halwallet.app').toLowerCase();
      const key = `${name}@${domain}`;
      const existing = state.names[key];
      if (!existing) return json({ error: 'unknown name' }, 404);
      if (existing.pubkey !== auth.pubkey && existing.manager !== auth.pubkey) return json({ error: 'not your name' }, 403);
      await cfDelete(domain, existing.recordId).catch(() => {});
      if (existing.offerId && ln) await ln.call('disableoffer', { offer_id: existing.offerId }).catch(() => {});
      delete state.names[key];
      persist();
      log(`released ${key}`);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
});

settleLoop().catch((e) => log('settle loop died:', e.message));
log(`names registrar for ${DOMAIN} on :${CFG.port || 8798} — ${Object.keys(state.names).length} name(s), offers ${ln ? 'on' : 'off'}, forwarder ${fwd ? 'on' : 'off'}`);
