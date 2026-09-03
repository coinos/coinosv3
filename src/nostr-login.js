// Log in with Nostr.
//
// Three ways to prove control of a nostr identity, in descending order of how
// much the browser gets to see:
//
//   extension  NIP-07 (Alby, nos2x, …) — the key stays in the extension
//   bunker     NIP-46 remote signer (Amber, Amethyst, nsec.app) — the key
//              stays on the signing device
//   key        a pasted nsec / hex private key — held in memory for this
//              session only, NEVER written to storage
//
// HOW A NOSTR ACCOUNT GETS A WALLET
// Two mechanisms, because the two situations are genuinely different:
//
// 1. We hold the private key (pasted nsec). The wallet seed is DERIVED from
//    it: entropy = sha256("coinos:wallet-seed:v1" | privkey). Deterministic,
//    so the same nostr key always opens the same wallet, on any device,
//    with nothing stored anywhere by anyone.
//
// 2. We only have a signer (extension/bunker). Deriving is impossible — we
//    never see the key, and neither signatures (random aux) nor NIP-44
//    ciphertexts (random nonce) are reproducible. So instead the wallet seed
//    is ASSOCIATED: a random seed is generated once and published as a
//    replaceable event encrypted to the user's own nostr key, which only
//    their signer can decrypt. Logging in later anywhere finds and decrypts
//    it, opening the same wallet.
//
// THE TRADEOFF, PLAINLY: mechanism 2 means whoever controls the nostr key can
// recover the wallet seed from public relays. That is a real escalation —
// a nostr key is usually treated as an identity, not as money. It is the
// price of "log in on a new device and your wallet is there" without the key
// itself ever reaching us. Mechanism 1 has no such exposure. The UI says so
// before publishing anything.

import { hex, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { getPublicKey, finalizeEvent, nip44 } from './nostr.js';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey } from 'nostr-tools/pure';

// NIP-46 loads lazily from dist/nip46.js (same pattern as the QR decoder):
// bunker logins are rare, and the module is heavy. Tests running outside a
// browser preset globalThis.__nip46 with the real module instead.
let _nip46 = null;
function loadNip46() {
  if (_nip46) return _nip46;
  if (typeof globalThis !== 'undefined' && globalThis.__nip46) return (_nip46 = Promise.resolve(globalThis.__nip46));
  _nip46 = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'nip46.js';
    s.onload = () => (window.__nip46 ? resolve(window.__nip46) : reject(new Error('signer module unavailable')));
    s.onerror = () => { _nip46 = null; reject(new Error('could not load the remote-signer module')); };
    document.head.appendChild(s);
  });
  return _nip46;
}

const SEED_DTAG = 'coinos:wallet:v1';
const BACKUP_KIND = 30078;
const DERIVE_TAG = 'coinos:wallet-seed:v1';

export const BACKUP_RELAYS = [
  'wss://relay.coinos.io', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net',
];

// nsec1… or 64-hex → 32-byte secret key, else null.
export function parseNostrSecret(input) {
  const s = String(input || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return hex.decode(s.toLowerCase());
  try {
    const { prefix, words } = bech32.decode(s, 1000);
    if (prefix !== 'nsec') return null;
    const b = bech32.fromWords(words);
    return b.length === 32 ? Uint8Array.from(b) : null;
  } catch { return null; }
}

// Mechanism 1: the same nostr key always yields the same wallet.
export function seedFromNostrKey(sk) {
  const tag = new TextEncoder().encode(DERIVE_TAG);
  const buf = new Uint8Array(tag.length + sk.length);
  buf.set(tag, 0);
  buf.set(sk, tag.length);
  return entropyToMnemonic(sha256(buf).slice(0, 16), wordlist); // 12 words
}

// ---- signers -------------------------------------------------------------
// Every signer exposes: pubkey, signEvent, encryptSelf, decryptSelf, label.

export async function extensionSigner() {
  const nostr = typeof window !== 'undefined' && window.nostr;
  if (!nostr) throw new Error('no nostr extension found in this browser');
  const pubkey = await nostr.getPublicKey();
  const canNip44 = !!(nostr.nip44 && nostr.nip44.encrypt && nostr.nip44.decrypt);
  if (!canNip44) throw new Error('this extension cannot encrypt (NIP-44 support required)');
  return {
    kind: 'extension', pubkey, label: 'browser extension',
    signEvent: (e) => nostr.signEvent(e),
    encryptSelf: (txt) => nostr.nip44.encrypt(pubkey, txt),
    decryptSelf: (ct) => nostr.nip44.decrypt(pubkey, ct),
    // peer variants: NIP-17 DMs seal to the recipient, not to self
    encryptTo: (peer, txt) => nostr.nip44.encrypt(peer, txt),
    decryptFrom: (peer, ct) => nostr.nip44.decrypt(peer, ct),
  };
}

export async function bunkerSigner(uri, { onAuth } = {}) {
  const { BunkerSigner, parseBunkerInput } = await loadNip46();
  const bp = await parseBunkerInput(String(uri || '').trim());
  if (!bp) throw new Error('not a bunker:// address');
  if (!bp.relays || !bp.relays.length) throw new Error('that bunker address lists no relays');
  const local = generateSecretKey();
  // NB the pointer goes through fromBunker — the constructor takes params
  // only, and passing the pointer there leaves the signer without one.
  const signer = BunkerSigner.fromBunker(local, bp, {
    onauth: (url) => { if (onAuth) onAuth(url); else if (typeof window !== 'undefined') window.open(url, '_blank'); },
  });
  await signer.connect();
  const pubkey = await signer.getPublicKey();
  return bunkerAdapter(signer, pubkey, local);
}

// Reconnect a remote signer a page reload dropped. The remote end granted
// permission to this client key, not to this page load, so rebuilding from
// the same client key and pointer picks the session back up — usually without
// prompting the user again.
export async function resumeBunker(session, { onAuth, timeoutMs = 15000 } = {}) {
  if (!session || !session.local || !session.bp || !session.bp.pubkey) return null;
  const { BunkerSigner } = await loadNip46();
  const local = hex.decode(session.local);
  const signer = BunkerSigner.fromBunker(local, session.bp, {
    onauth: (url) => { if (onAuth) onAuth(url); },
  });
  const give = new Promise((_, rej) => setTimeout(() => rej(new Error('signer did not answer')), timeoutMs));
  try {
    await Promise.race([signer.connect(), give]);
    const pubkey = await Promise.race([signer.getPublicKey(), give]);
    return bunkerAdapter(signer, pubkey, local);
  } catch (e) {
    try { signer.close(); } catch {}
    throw e;
  }
}

function bunkerAdapter(signer, pubkey, local) {
  // A dead transport (relay socket gone, signer app killed in the background)
  // makes a NIP-46 call hang forever, not fail — so every operation carries
  // its own deadline. The distinct message lets callers tell "the signer
  // never answered" (connection is dead, reconnect) from "the signer said
  // no" (an answered error — the connection is fine).
  const answered = (p, ms = 20_000) => Promise.race([p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('signer did not answer')), ms))]);
  return {
    kind: 'bunker', pubkey, label: 'remote signer',
    // Everything needed to rebuild this connection later. `local` is the
    // client key the remote signer authorised — not the user's identity key,
    // which never leaves the signer.
    session: local ? { local: hex.encode(local), bp: signer.bp } : null,
    signEvent: (e) => answered(signer.signEvent(e)),
    encryptSelf: (txt) => answered(signer.nip44Encrypt(pubkey, txt)),
    decryptSelf: (ct) => answered(signer.nip44Decrypt(pubkey, ct)),
    encryptTo: (peer, txt) => answered(signer.nip44Encrypt(peer, txt)),
    decryptFrom: (peer, ct) => answered(signer.nip44Decrypt(peer, ct)),
    close: () => { try { signer.close(); } catch {} },
  };
}

// Client-initiated NIP-46: WE mint a nostrconnect:// URI; a signer app
// (Amber, nsec.app, …) opens or scans it and connects back to us over the
// relay — no bunker URL to copy. Returns the URI (render it as a deep link
// and a QR), a promise that resolves to a signer adapter when the app
// answers, and a cancel.
//
// SURVIVAL: launching the signer app on a phone FREEZES this tab — its relay
// sockets die exactly when the approval is being published, and a limit:0
// subscription never replays what it slept through. Worse, a signer's
// callbackUrl can NAVIGATE the tab home, reloading the page and discarding
// the client key mid-handshake. So the pending handshake is persisted
// (sessionStorage) and the wait runs two paths: the library's live
// subscription, raced against a stored-event poller that re-queries the
// relays (kicked on every return to visibility) — whichever sees the
// approval first wins. `nostrConnectPending()` hands a fresh boot the
// persisted handshake so a reloaded page resumes instead of shrugging.
const NC_PENDING_KEY = 'nc-pending';
export function nostrConnectPending(timeoutMs = 180_000) {
  try {
    const p = JSON.parse(sessionStorage.getItem(NC_PENDING_KEY) || 'null');
    if (p && p.local && p.secret && p.uri && Date.now() - p.ts < timeoutMs) return p;
    if (p) sessionStorage.removeItem(NC_PENDING_KEY);
  } catch {}
  return null;
}
export async function nostrConnect({ relays = ['wss://relay.coinos.io', 'wss://nos.lol'], timeoutMs = 180_000, resume = null } = {}) {
  const { BunkerSigner, createNostrConnectURI } = await loadNip46();
  const local = resume ? hex.decode(resume.local) : generateSecretKey();
  const secret = resume ? resume.secret : hex.encode(crypto.getRandomValues(new Uint8Array(16)));
  const startedAt = resume ? resume.ts : Date.now();
  if (resume && resume.relays) relays = resume.relays;
  const uri = resume ? resume.uri : createNostrConnectURI({
    clientPubkey: getPublicKey(local),
    relays,
    secret,
    name: 'coinos',
    url: 'https://v3.coinos.io',
    perms: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
  }) + '&callbackUrl=' + encodeURIComponent('https://v3.coinos.io/');
  try {
    sessionStorage.setItem(NC_PENDING_KEY, JSON.stringify({
      local: hex.encode(local), secret, relays, uri, ts: startedAt,
    }));
  } catch {}
  const clientPub = getPublicKey(local);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('signer connect timed out')),
    Math.max(5_000, timeoutMs - (Date.now() - startedAt)));

  // Path 1: the library's live wait — instant while the tab stays awake.
  const live = (async () => BunkerSigner.fromURI(local, uri, {}, controller.signal))();
  live.catch(() => {});

  // Path 2: the replay poller — finds an approval published while we slept.
  let visKick = null;
  const onVis = () => { if (document.visibilityState === 'visible' && visKick) visKick(); };
  document.addEventListener('visibilitychange', onVis);
  const replay = (async () => {
    const seen = new Set();
    while (!controller.signal.aborted) {
      await new Promise((r) => {
        visKick = r;
        const t2 = setTimeout(r, 5000);
        controller.signal.addEventListener('abort', () => { clearTimeout(t2); r(); }, { once: true });
      });
      visKick = null;
      if (controller.signal.aborted) break;
      const pool = new SimplePool();
      try {
        const evs = await Promise.any(relays.map(async (url) => {
          await pool.ensureRelay(url, { connectionTimeout: 4000 });
          const got = await pool.querySync([url], {
            kinds: [24133], '#p': [clientPub], since: Math.floor(startedAt / 1000) - 120,
          }, { maxWait: 4500 });
          if (!got || !got.length) throw new Error('nothing yet');
          return got;
        })).catch(() => []);
        for (const ev of evs || []) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          try {
            const key = nip44.getConversationKey(local, ev.pubkey);
            const resp = JSON.parse(nip44.decrypt(ev.content, key));
            // some signers echo the secret, others answer a bare "ack"
            if (resp.result === secret || resp.result === 'ack') {
              return BunkerSigner.fromBunker(local, { pubkey: ev.pubkey, relays, secret });
            }
          } catch {}
        }
      } catch {} finally { try { pool.close(relays); } catch {} }
    }
    throw controller.signal.reason || new Error('cancelled');
  })();
  replay.catch(() => {});

  const ready = (async () => {
    try {
      const signer = await Promise.any([live, replay]);
      const pubkey = await signer.getPublicKey();
      try { sessionStorage.removeItem(NC_PENDING_KEY); } catch {}
      return bunkerAdapter(signer, pubkey, local);
    } catch (e) {
      // an aborted wait names its real cause (timeout, user cancel); a raw
      // AggregateError from the race names nothing useful
      throw (controller.signal.aborted && controller.signal.reason)
        || (e && e.errors && e.errors[0]) || e;
    } finally {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      controller.abort(new Error('settled'));
    }
  })();
  ready.catch(() => {});
  return {
    uri, ready,
    cancel: (reason) => {
      try { sessionStorage.removeItem(NC_PENDING_KEY); } catch {}
      controller.abort(reason || new Error('cancelled'));
    },
  };
}

// A pasted key: signing happens locally, and the key is never persisted.
export function keySigner(sk) {
  const pubkey = getPublicKey(sk);
  const conv = nip44.getConversationKey(sk, pubkey);
  return {
    kind: 'key', pubkey, label: 'private key', secret: sk,
    signEvent: async (e) => finalizeEvent(e, sk),
    encryptSelf: async (txt) => nip44.encrypt(txt, conv),
    decryptSelf: async (ct) => nip44.decrypt(ct, conv),
    encryptTo: async (peer, txt) => nip44.encrypt(txt, nip44.getConversationKey(sk, peer)),
    decryptFrom: async (peer, ct) => nip44.decrypt(ct, nip44.getConversationKey(sk, peer)),
  };
}

// ---- the encrypted wallet association (mechanism 2) ----------------------

// Look for a wallet this nostr account already published. Returns the
// mnemonic, or null when the account has no wallet yet.
//
// "No wallet" is a claim, not a default: acting on it mints a NEW wallet
// whose backup would replace this one on every relay it reaches. So absence
// is only believed when at least one relay actually answered, and a backup
// we can see but not decrypt is an error, never a shrug — each query is
// per-relay because a pooled query swallows individual connection failures.
export async function fetchWalletBackup(signer, relays = BACKUP_RELAYS) {
  const pool = new SimplePool();
  const filter = { kinds: [BACKUP_KIND], authors: [signer.pubkey], '#d': [SEED_DTAG] };
  try {
    const results = await Promise.allSettled(relays.map(async (url) => {
      await pool.ensureRelay(url, { connectionTimeout: 5000 });
      return pool.querySync([url], filter, { maxWait: 6000 });
    }));
    const answered = results.filter((r) => r.status === 'fulfilled');
    if (!answered.length) throw new Error('could not reach any relay to look for an existing wallet — check your connection and try again');
    const newest = answered.flatMap((r) => r.value).sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) return null;
    let body;
    try { body = JSON.parse(await signer.decryptSelf(newest.content)); }
    catch { throw new Error('found this account’s wallet but could not decrypt it — approve the decryption prompt in your signer and try again'); }
    if (!body || !body.mnemonic) throw new Error('found this account’s wallet backup but it is unreadable');
    return body;
  } finally { try { pool.close(relays); } catch {} }
}

// Publish (or replace) the encrypted wallet association for this account.
// `spending` rides along as a hint: a restored wallet paints its Spending
// side from the first frame instead of reflowing when the name lookup proves
// it seconds later.
export async function publishWalletBackup(signer, { mnemonic, passphrase, spending }, relays = BACKUP_RELAYS) {
  const content = await signer.encryptSelf(JSON.stringify({ mnemonic, passphrase: passphrase || '', ...(spending ? { spending: true } : {}) }));
  const evt = await signer.signEvent({
    kind: BACKUP_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', SEED_DTAG]], content,
  });
  const pool = new SimplePool();
  try {
    const res = await Promise.allSettled(pool.publish(relays, evt));
    if (!res.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the backup');
  } finally { try { pool.close(relays); } catch {} }
  return true;
}

// The whole login: given a signer, produce the wallet mnemonic to open.
// `mode` reports what happened so the UI can be honest about it.
//
// ONE flow for all three signer kinds, because an identity must open the
// SAME wallet however you log into it: look for the published association
// FIRST (that's where the money already is), and only then fall back to
// deriving (key in hand) or generating (signer only).
export async function walletForSigner(signer) {
  const found = await fetchWalletBackup(signer);
  if (found) return { mnemonic: found.mnemonic, passphrase: found.passphrase, spending: !!found.spending, mode: 'restored' };
  if (signer.secret) {
    // Publishing the derived seed costs nothing: the derivation is public,
    // so anyone holding this key could compute it anyway. It buys the thing
    // that matters — an extension login later finds this same wallet.
    return { mnemonic: seedFromNostrKey(signer.secret), mode: 'derived', publish: true };
  }
  return { mnemonic: null, mode: 'new' }; // caller decides + confirms publishing
}

// NIP-98 HTTP Auth (kind 27235): the standard way to authenticate an HTTP
// request with a nostr key. `u` and `method` bind the signature to this exact
// request and `payload` to its body, so a captured header can't be replayed
// against a different endpoint or a tampered body.
