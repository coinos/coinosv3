// blossom.coinos.io — a Blossom (BUD-01/02/06/12) blob server that stores
// ONE kind of thing: encrypted wallet-sync envelopes. The wallet keeps its
// cross-device state in nostr replaceable events, but a deep Ark coin set
// outgrows a relay's event cap; those domains go here as an encrypted blob
// and the nostr event carries only its hash. Any Blossom server can hold the
// blob (content-addressed), so users can self-host or pick another provider.
//
// Abuse policy — this must never become a file host:
//   * uploads, listing and deletion need a signed kind-24242 event (BUD-11)
//   * a blob is stored only if it starts with the wallet's envelope magic
//     ("CSB1" + 24-byte nonce): everything else is 415, so images, video and
//     arbitrary files are refused at the door
//   * blobs are always served as application/octet-stream, as an attachment,
//     nosniff — nothing here renders in a browser or embeds anywhere
//   * per-blob size cap, per-pubkey quota (bytes and count, oldest evicted),
//     per-IP/pubkey rate limits, a global disk cap, and unused-blob expiry
//
// Run: bun blossom/server.js  (env: BLOSSOM_DATA, BLOSSOM_PORT, BLOSSOM_HOST,
//      BLOSSOM_MAX_BLOB, BLOSSOM_QUOTA_BYTES, BLOSSOM_QUOTA_COUNT,
//      BLOSSOM_DISK_CAP, BLOSSOM_TTL_DAYS)

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

const DATA = process.env.BLOSSOM_DATA || join(import.meta.dir, 'data');
const PORT = Number(process.env.BLOSSOM_PORT || 8796);
const HOST = process.env.BLOSSOM_HOST || 'blossom.coinos.io';
const PUBLIC_BASE = process.env.BLOSSOM_PUBLIC_BASE || `https://${HOST}`;
const MAX_BLOB = Number(process.env.BLOSSOM_MAX_BLOB || 8 * 1024 * 1024);      // 8 MB per blob
const QUOTA_BYTES = Number(process.env.BLOSSOM_QUOTA_BYTES || 32 * 1024 * 1024); // 32 MB per pubkey
const QUOTA_COUNT = Number(process.env.BLOSSOM_QUOTA_COUNT || 24);              // blobs per pubkey
const DISK_CAP = Number(process.env.BLOSSOM_DISK_CAP || 40 * 1024 * 1024 * 1024); // 40 GB total
const TTL_DAYS = Number(process.env.BLOSSOM_TTL_DAYS || 365);                  // unused-blob expiry
const MAGIC = new TextEncoder().encode('CSB1');
const ENVELOPE_MIN = MAGIC.length + 24 + 16; // magic + nonce + poly1305 tag

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// storage: blobs/<sha256> on disk, a small JSON index for ownership + times
// ---------------------------------------------------------------------------
const BLOBS = join(DATA, 'blobs');
const INDEX = join(DATA, 'index.json');
mkdirSync(BLOBS, { recursive: true });
let index = (() => {
  try { return JSON.parse(readFileSync(INDEX, 'utf8')); } catch { return { blobs: {} }; }
})();
// index.blobs[sha] = { size, uploaded, touched, owners: { [pubkey]: uploadedAt } }
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const tmp = INDEX + '.tmp';
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, INDEX);
  }, 200);
}
const blobPath = (sha) => join(BLOBS, sha);
const totalBytes = () => Object.values(index.blobs).reduce((n, b) => n + b.size, 0);
const ownedBy = (pk) => Object.entries(index.blobs).filter(([, b]) => b.owners[pk]).map(([sha, b]) => ({ sha, ...b }));

function descriptor(sha, b) {
  return { url: `${PUBLIC_BASE}/${sha}`, sha256: sha, size: b.size, type: 'application/octet-stream', uploaded: Math.floor(b.uploaded / 1000) };
}
function dropBlob(sha) {
  delete index.blobs[sha];
  try { unlinkSync(blobPath(sha)); } catch {}
}
// Remove a pubkey's claim; the file goes when nobody claims it.
function disown(sha, pk) {
  const b = index.blobs[sha];
  if (!b) return;
  delete b.owners[pk];
  if (!Object.keys(b.owners).length) dropBlob(sha);
}
// Quota: a pubkey keeps at most QUOTA_COUNT blobs / QUOTA_BYTES — the OLDEST
// go first, so a client that forgets to delete superseded snapshots keeps
// working (the newest state is what sync needs).
function enforceQuota(pk, incomingSize) {
  const mine = ownedBy(pk).sort((a, b) => a.owners[pk] - b.owners[pk]);
  let bytes = mine.reduce((n, b) => n + b.size, 0) + incomingSize;
  let count = mine.length + 1;
  for (const b of mine) {
    if (count <= QUOTA_COUNT && bytes <= QUOTA_BYTES) break;
    disown(b.sha, pk);
    bytes -= b.size; count--;
  }
  return count <= QUOTA_COUNT && bytes <= QUOTA_BYTES;
}
// Blobs nobody fetched or re-uploaded in TTL_DAYS are abandoned wallets'
// snapshots (or a client that moved on) — sweep them.
function sweep() {
  const cutoff = Date.now() - TTL_DAYS * 86400_000;
  let n = 0;
  for (const [sha, b] of Object.entries(index.blobs)) if ((b.touched || b.uploaded) < cutoff) { dropBlob(sha); n++; }
  if (n) { log('swept', n, 'expired blobs'); persist(); }
}
setInterval(sweep, 6 * 3600_000);
sweep();

// ---------------------------------------------------------------------------
// auth (BUD-11): kind 24242, t=verb, expiration in the future, x=sha when the
// endpoint names a blob, optional server tags naming us
// ---------------------------------------------------------------------------
function checkAuth(req, verb, sha = null) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Nostr\s+(.+)$/i);
  if (!m) return { error: 'missing Nostr authorization' };
  let evt;
  try { evt = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return { error: 'bad auth encoding' }; }
  if (!evt || evt.kind !== 24242) return { error: 'auth must be kind 24242' };
  const now = Math.floor(Date.now() / 1000);
  if (!(evt.created_at <= now + 60)) return { error: 'auth created in the future' };
  const tags = Array.isArray(evt.tags) ? evt.tags : [];
  const tag = (k) => tags.filter((x) => x[0] === k).map((x) => x[1]);
  const exp = Number(tag('expiration')[0]);
  if (!exp || exp <= now) return { error: 'auth expired' };
  if (!tag('t').includes(verb)) return { error: `auth is not for ${verb}` };
  const servers = tag('server');
  if (servers.length && !servers.some((s) => String(s).toLowerCase() === HOST)) return { error: 'auth is for another server' };
  if (sha && !tag('x').includes(sha)) return { error: 'auth does not name this blob' };
  if (!verifyEvent(evt)) return { error: 'bad signature' };
  return { pubkey: evt.pubkey };
}

// ---------------------------------------------------------------------------
// rate limits: per IP and per pubkey, sliding minute
// ---------------------------------------------------------------------------
const rate = new Map();
function rateOk(key, limit) {
  const now = Date.now();
  const arr = (rate.get(key) || []).filter((t) => t > now - 60_000);
  if (arr.length >= limit) return false;
  arr.push(now);
  rate.set(key, arr);
  if (rate.size > 5000) for (const [k, v] of rate) { if (!v.some((t) => t > now - 60_000)) rate.delete(k); }
  return true;
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, X-Content-Length, X-Content-Type, *',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Reason, Content-Length',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } });
const fail = (status, reason) => json({ message: reason }, status, { 'X-Reason': reason });
const SHA_RE = /^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/;

// Envelope check: our client's sealed snapshot, nothing else.
function envelopeOk(head, size) {
  if (size < ENVELOPE_MIN || size > MAX_BLOB) return false;
  for (let i = 0; i < MAGIC.length; i++) if (head[i] !== MAGIC[i]) return false;
  return true;
}
// BUD-06 style policy check shared by HEAD /upload and PUT /upload.
function uploadPolicy(size, head, pk) {
  if (!Number.isFinite(size) || size <= 0) return fail(411, 'X-Content-Length required');
  if (size > MAX_BLOB) return fail(413, `blob exceeds ${MAX_BLOB} bytes`);
  if (head && !envelopeOk(head, size)) return fail(415, 'only coinos wallet sync envelopes are stored here');
  if (totalBytes() + size > DISK_CAP) return fail(503, 'storage full');
  if (pk && !enforceQuota(pk, size)) return fail(413, 'per-key quota exceeded');
  return null;
}

Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_BLOB + 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/' && req.method === 'GET') {
      return json({ name: HOST, about: 'coinos wallet sync storage (Blossom). Stores encrypted wallet snapshots only.',
        maxBlob: MAX_BLOB, quotaBytes: QUOTA_BYTES, quotaCount: QUOTA_COUNT, blobs: Object.keys(index.blobs).length });
    }

    // ---- upload requirements (BUD-06) ----
    if (url.pathname === '/upload' && req.method === 'HEAD') {
      if (!rateOk('ip:' + ip, 120)) return fail(429, 'rate limited');
      const sha = (req.headers.get('x-sha-256') || '').toLowerCase();
      const a = checkAuth(req, 'upload', /^[0-9a-f]{64}$/.test(sha) ? sha : null);
      if (a.error) return fail(401, a.error);
      const size = Number(req.headers.get('x-content-length'));
      if (!Number.isFinite(size) || size <= 0) return fail(411, 'X-Content-Length required');
      if (size < ENVELOPE_MIN) return fail(415, 'only coinos wallet sync envelopes are stored here');
      const type = (req.headers.get('x-content-type') || '').split(';')[0].trim();
      if (type && type !== 'application/octet-stream') return fail(415, 'only application/octet-stream sync envelopes are stored here');
      // quota is not checked here: PUT evicts the key's oldest blob to make room
      const bad = uploadPolicy(size, null, null);
      if (bad) return bad;
      return new Response(null, { status: 200, headers: CORS });
    }

    // ---- upload (BUD-02) ----
    if (url.pathname === '/upload' && req.method === 'PUT') {
      if (!rateOk('ip:' + ip, 60)) return fail(429, 'rate limited');
      const bytes = new Uint8Array(await req.arrayBuffer());
      const sha = createHash('sha256').update(bytes).digest('hex');
      const a = checkAuth(req, 'upload', sha);
      if (a.error) return fail(401, a.error);
      if (!rateOk('pk:' + a.pubkey, 30)) return fail(429, 'rate limited');
      const want = (req.headers.get('x-sha-256') || '').toLowerCase();
      if (want && want !== sha) return fail(409, 'X-SHA-256 does not match the body');
      const type = (req.headers.get('content-type') || '').split(';')[0].trim();
      if (type && type !== 'application/octet-stream') return fail(415, 'only application/octet-stream sync envelopes are stored here');
      const existing = index.blobs[sha];
      const bad = uploadPolicy(bytes.length, bytes.subarray(0, MAGIC.length), existing?.owners[a.pubkey] ? null : a.pubkey);
      if (bad) return bad;
      const now = Date.now();
      if (!existing) {
        writeFileSync(blobPath(sha), bytes);
        index.blobs[sha] = { size: bytes.length, uploaded: now, touched: now, owners: { [a.pubkey]: now } };
      } else {
        existing.touched = now;
        existing.owners[a.pubkey] = existing.owners[a.pubkey] || now;
      }
      persist();
      log('upload', sha.slice(0, 12), bytes.length, 'b', a.pubkey.slice(0, 8), existing ? '(exists)' : '');
      return json(descriptor(sha, index.blobs[sha]), existing ? 200 : 201);
    }

    // ---- list (BUD-12): only the owner sees their own blobs ----
    const lm = url.pathname.match(/^\/list\/([0-9a-f]{64})$/);
    if (lm && req.method === 'GET') {
      if (!rateOk('ip:' + ip, 120)) return fail(429, 'rate limited');
      const a = checkAuth(req, 'list');
      if (a.error) return fail(401, a.error);
      if (a.pubkey !== lm[1]) return fail(403, 'you can only list your own blobs');
      const since = Number(url.searchParams.get('since')) || 0, until = Number(url.searchParams.get('until')) || Infinity;
      const list = ownedBy(a.pubkey)
        .map((b) => descriptor(b.sha, b))
        .filter((d) => d.uploaded >= since && d.uploaded <= until)
        .sort((x, y) => y.uploaded - x.uploaded);
      return json(list);
    }

    // ---- fetch / delete a blob ----
    const bm = url.pathname.match(SHA_RE);
    if (bm) {
      const sha = bm[1];
      const b = index.blobs[sha];
      if (req.method === 'DELETE') {
        if (!rateOk('ip:' + ip, 120)) return fail(429, 'rate limited');
        const a = checkAuth(req, 'delete', sha);
        if (a.error) return fail(401, a.error);
        if (!b) return fail(404, 'no such blob');
        if (!b.owners[a.pubkey]) return fail(403, 'not your blob');
        disown(sha, a.pubkey);
        persist();
        log('delete', sha.slice(0, 12), a.pubkey.slice(0, 8));
        return new Response(null, { status: 204, headers: CORS });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!rateOk('ip:' + ip, 300)) return fail(429, 'rate limited');
        if (!b || !existsSync(blobPath(sha))) return fail(404, 'no such blob');
        b.touched = Date.now(); persist();
        const headers = {
          ...CORS,
          'content-type': 'application/octet-stream',
          'content-length': String(b.size),
          'content-disposition': `attachment; filename="${sha}.bin"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=31536000, immutable',
        };
        if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(Bun.file(blobPath(sha)), { status: 200, headers });
      }
    }
    return fail(404, 'not found');
  },
});
log(`blossom ${HOST} on :${PORT} — ${Object.keys(index.blobs).length} blobs, ${(totalBytes() / 1e6).toFixed(1)} MB, data ${DATA}`);
