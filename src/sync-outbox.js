// Durable, already-encrypted and signed wallet snapshots. No signing keys or
// plaintext wallet state enter storage. Keep the last acknowledged copy too:
// it is a local recovery source when an account cache has been cleared.
//
// A record may carry a sealed BLOB (an oversized domain bound for Blossom
// storage) beside its pointer event: the blob uploads first, to at least one
// server, then the event publishes. Its upload/delete authorizations are
// signed at enqueue time (kind 24242 with an expiry), so delivery after
// logout still needs no key.
const PREFIX = 'btc-wallet-sync-outbox:';

export class SyncOutbox {
  constructor({ storage, send, upload = async () => false, remove = async () => false, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), warn = (...args) => console.warn(...args) }) {
    Object.assign(this, { storage, send, upload, remove, now, schedule, cancel, warn });
    this.timer = null;
    this.running = false;
    this.retryMs = 5000;
  }

  records() {
    const out = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const record = JSON.parse(this.storage.getItem(key));
        if (record?.event?.kind === 30078 && Array.isArray(record.relays)) out.push({ key, ...record });
      } catch {}
    }
    return out;
  }

  events(pubkey) { return this.records().filter(r => r.event.pubkey === pubkey).map(r => r.event); }

  // The sealed bytes behind one of our own pointer events — local recovery
  // needs no server round trip.
  localBlob(sha256) {
    const r = this.records().find(r => r.blob?.sha256 === sha256 && r.blob.data);
    return r ? b64decode(r.blob.data) : null;
  }

  clear() {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    for (const { key } of this.records()) this.storage.removeItem(key);
  }

  // blob: { sha256, size, data (base64), servers, auth (upload authorization),
  //         deleteAuthFor?: sha => authorization } — the last lets a superseded
  // blob be removed from its servers once the new one is acknowledged.
  enqueue({ pubkey, dtag, digest, relays, sign, blob = null }) {
    const key = PREFIX + pubkey + ':' + dtag;
    let previous;
    try { previous = JSON.parse(this.storage.getItem(key)); } catch {}
    // Same content, same route: nothing to do. A record that changed route
    // (an oversized domain now bound for Blossom, or back inline) is replaced
    // even for identical content — the stuck relay-only copy must go.
    if (previous?.digest === digest && !!previous.blob === !!blob) { this.wake(); return; }
    // A pending, never-sent event can be replaced within the same second.
    // Once attempted, use a later timestamp: Nostr resolves equal timestamps
    // by event id, which can otherwise leave the OLD snapshot in the relay.
    const createdAt = Math.max(Math.floor(this.now() / 1000),
      (previous?.event?.created_at || 0) + (previous?.attempted ? 1 : 0));
    const event = sign(createdAt);
    if (!event || event.pubkey !== pubkey) throw new Error('Cannot sign wallet sync snapshot');
    // Superseded blobs still sitting on servers: carry their cleanup forward.
    const cleanup = (previous?.cleanup || []).slice();
    const prevBlob = previous?.blob;
    if (prevBlob?.sha256 && prevBlob.sha256 !== blob?.sha256 && (previous.uploaded || []).length && blob?.deleteAuthFor) {
      try { cleanup.push({ sha256: prevBlob.sha256, servers: previous.uploaded, auth: blob.deleteAuthFor(prevBlob.sha256) }); } catch {}
    }
    const stored = blob ? { sha256: blob.sha256, size: blob.size, data: blob.data, servers: blob.servers, auth: blob.auth } : undefined;
    // The same blob re-enqueued (e.g. only the pointer changed) keeps its uploads.
    const uploaded = blob && prevBlob?.sha256 === blob.sha256 ? (previous.uploaded || []) : [];
    this.storage.setItem(key, JSON.stringify({ event, digest, relays, blob: stored, uploaded, cleanup, attempted: false, acknowledged: false }));
    this.wake();
  }

  wake(delay = 0) {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = this.schedule(() => { this.timer = null; this.flush(); }, delay);
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    let failed = false;
    try {
      // Independent domains must not wait for the slowest relay request.
      await Promise.all(this.records().filter(r => !r.acknowledged && r.event.created_at * 1000 <= this.now()).map(async r => {
        try {
          // Re-read before writing: another tab may have queued a newer copy.
          const current = JSON.parse(this.storage.getItem(r.key));
          if (current?.event?.id !== r.event.id) return;
          // The blob must land on at least one server before its pointer goes out.
          if (current.blob && !(current.uploaded || []).length) {
            const bytes = b64decode(current.blob.data);
            const ok = [];
            await Promise.all((current.blob.servers || []).map(async s => {
              try { if (await this.upload(s, bytes, current.blob.auth)) ok.push(s); } catch {}
            }));
            const again = JSON.parse(this.storage.getItem(r.key));
            if (again?.event?.id !== r.event.id) return;
            if (!ok.length) { failed = true; this.warn('wallet sync blob upload will retry'); return; }
            again.uploaded = ok;
            this.storage.setItem(r.key, JSON.stringify(again));
            Object.assign(current, again);
          }
          current.attempted = true;
          this.storage.setItem(r.key, JSON.stringify(current));
          const ok = await this.send(r.event, r.relays);
          if (!ok) { failed = true; return; }
          const latest = JSON.parse(this.storage.getItem(r.key));
          if (latest?.event?.id === r.event.id) {
            latest.acknowledged = true;
            this.storage.setItem(r.key, JSON.stringify(latest));
          }
        } catch (e) { failed = true; this.warn('wallet sync will retry:', e.message); }
      }));
      await this.cleanup();
    } finally {
      this.running = false;
      const pending = this.records().filter(r => !r.acknowledged);
      if (pending.length) {
        const due = Math.max(0, Math.min(...pending.map(r => r.event.created_at * 1000)) - this.now());
        this.wake(Math.max(due, failed ? this.retryMs : 0));
        this.retryMs = failed ? Math.min(this.retryMs * 2, 60000) : 5000;
      } else this.retryMs = 5000;
    }
  }

  // Best-effort removal of superseded blobs once their replacement is
  // acknowledged. A server that refuses just keeps the blob until its own
  // quota or expiry drops it.
  async cleanup() {
    for (const r of this.records()) {
      if (!r.acknowledged || !(r.cleanup || []).length) continue;
      const left = [];
      for (const c of r.cleanup) {
        const servers = [];
        for (const s of c.servers || []) { try { if (!(await this.remove(s, c.sha256, c.auth))) servers.push(s); } catch { servers.push(s); } }
        if (servers.length && (c.tries || 0) < 5) left.push({ ...c, servers, tries: (c.tries || 0) + 1 });
      }
      const latest = JSON.parse(this.storage.getItem(r.key));
      if (latest?.event?.id === r.event.id) { latest.cleanup = left; this.storage.setItem(r.key, JSON.stringify(latest)); }
    }
  }
}

function b64decode(s) {
  if (typeof atob === 'function') { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  return new Uint8Array(Buffer.from(s, 'base64'));
}
