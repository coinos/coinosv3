// Oversized sync domains ride Blossom (nostr blob storage) instead of a relay
// event: a relay caps events at 64KB and NIP-44 caps plaintext at 64KB, but a
// deep Ark coin set is hundreds of KB. The domain is sealed into an envelope
// (magic + xchacha20poly1305 under a key derived from the wallet's own NIP-44
// self-key), uploaded to one or more Blossom servers, and the kind-30078
// event carries only { blob: { sha256, size, servers } }. Content addressing
// means any server can hold the blob — users can self-host or pick another
// provider in Settings → Nostr, and the coinos server accepts nothing but
// these envelopes (see blossom/server.js).

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { finalizeEvent } from 'nostr-tools/pure';

export const BLOB_MAGIC = new TextEncoder().encode('CSB1');
export const DEFAULT_BLOSSOM_SERVERS = ['https://blossom.coinos.io'];
const CONFIG_KEY = 'btc-wallet-blossom';
const NONCE_LEN = 24;

// ---- server list ----------------------------------------------------------
export const normalizeServer = (s) => {
  const u = String(s || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/i.test(u) ? u : null;
};
export function getBlossomConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (c && Array.isArray(c.servers)) return { servers: c.servers.map(normalizeServer).filter(Boolean), manual: !!c.manual };
  } catch {}
  return { servers: DEFAULT_BLOSSOM_SERVERS.slice(), manual: false };
}
export function setBlossomConfig({ servers, manual = false }) {
  const list = [...new Set((servers || []).map(normalizeServer).filter(Boolean))].slice(0, 6);
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ servers: list, manual })); } catch {}
  return list;
}
// Where to upload: the configured list, else the default.
export const blossomServers = () => {
  const { servers } = getBlossomConfig();
  return servers.length ? servers : DEFAULT_BLOSSOM_SERVERS.slice();
};

// ---- envelope ------------------------------------------------------------
// ck is the wallet's NIP-44 self conversation key (32 bytes, seed-derived) —
// the same secret that already protects every relay snapshot.
const blobKey = (ck) => hkdf(sha256, ck, undefined, 'coinos-sync-blob-v1', 32);
export const sha256Hex = (bytes) => bytesToHex(sha256(bytes));

export function sealBlob(ck, text) {
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(blobKey(ck), nonce).encrypt(new TextEncoder().encode(text));
  const out = new Uint8Array(BLOB_MAGIC.length + NONCE_LEN + ct.length);
  out.set(BLOB_MAGIC, 0); out.set(nonce, BLOB_MAGIC.length); out.set(ct, BLOB_MAGIC.length + NONCE_LEN);
  return out;
}
export function openBlob(ck, bytes) {
  for (let i = 0; i < BLOB_MAGIC.length; i++) if (bytes[i] !== BLOB_MAGIC[i]) throw new Error('not a sync envelope');
  const nonce = bytes.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + NONCE_LEN);
  const pt = xchacha20poly1305(blobKey(ck), nonce).decrypt(bytes.subarray(BLOB_MAGIC.length + NONCE_LEN));
  return new TextDecoder().decode(pt);
}

// ---- Blossom auth (BUD-11): kind 24242, signed up front so the durable
// outbox can deliver after logout without holding a key ------------------
export function blobAuth(sk, verb, shas = [], { ttlSec = 7 * 86400, content } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent({
    kind: 24242,
    created_at: now - 5, // a client clock slightly ahead of the server's is not a rejection
    content: content || `coinos wallet sync: ${verb}`,
    tags: [['t', verb], ['expiration', String(now + ttlSec)], ...shas.map((x) => ['x', x])],
  }, sk);
}
export const authHeader = (evt) => 'Nostr ' + base64.encode(new TextEncoder().encode(JSON.stringify(evt)));

// ---- transport ---------------------------------------------------------
const withTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};
export async function uploadBlob(server, bytes, auth, { timeoutMs = 30000 } = {}) {
  const base = normalizeServer(server); if (!base) return false;
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(base + '/upload', {
      method: 'PUT', signal: t.signal, body: bytes,
      headers: { Authorization: authHeader(auth), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha256Hex(bytes) },
    });
    return r.status === 200 || r.status === 201;
  } catch { return false; } finally { t.done(); }
}
export async function deleteBlob(server, sha, auth, { timeoutMs = 15000 } = {}) {
  const base = normalizeServer(server); if (!base) return false;
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(`${base}/${sha}`, { method: 'DELETE', signal: t.signal, headers: { Authorization: authHeader(auth) } });
    return r.ok || r.status === 404;
  } catch { return false; } finally { t.done(); }
}
// First server that returns bytes hashing to `sha` wins; a mismatch is a
// lying (or corrupted) server and is skipped like a miss.
export async function fetchBlob(servers, sha, { timeoutMs = 30000 } = {}) {
  for (const s of servers) {
    const base = normalizeServer(s); if (!base) continue;
    const t = withTimeout(timeoutMs);
    try {
      const r = await fetch(`${base}/${sha}`, { signal: t.signal });
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (sha256Hex(bytes) === sha) return bytes;
    } catch {} finally { t.done(); }
  }
  return null;
}
