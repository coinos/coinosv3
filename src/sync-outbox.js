// Durable, already-encrypted and signed wallet snapshots. No signing keys or
// plaintext wallet state enter storage. Keep the last acknowledged copy too:
// it is a local recovery source when an account cache has been cleared.
const PREFIX = 'btc-wallet-sync-outbox:';

export class SyncOutbox {
  constructor({ storage, send, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), warn = (...args) => console.warn(...args) }) {
    Object.assign(this, { storage, send, now, schedule, cancel, warn });
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

  clear() {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    for (const { key } of this.records()) this.storage.removeItem(key);
  }

  enqueue({ pubkey, dtag, digest, relays, sign }) {
    const key = PREFIX + pubkey + ':' + dtag;
    let previous;
    try { previous = JSON.parse(this.storage.getItem(key)); } catch {}
    if (previous?.digest === digest) { this.wake(); return; }
    // A pending, never-sent event can be replaced within the same second.
    // Once attempted, use a later timestamp: Nostr resolves equal timestamps
    // by event id, which can otherwise leave the OLD snapshot in the relay.
    const createdAt = Math.max(Math.floor(this.now() / 1000),
      (previous?.event?.created_at || 0) + (previous?.attempted ? 1 : 0));
    const event = sign(createdAt);
    if (!event || event.pubkey !== pubkey) throw new Error('Cannot sign wallet sync snapshot');
    this.storage.setItem(key, JSON.stringify({ event, digest, relays, attempted: false, acknowledged: false }));
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
}
