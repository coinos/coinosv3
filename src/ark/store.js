// Ark state storage: IndexedDB with the coins' signed bytes as raw
// Uint8Arrays, fronted by an in-memory copy so every read and write the app
// makes stays synchronous (the render path reads it, the manager saves it).
//
// Why not localStorage: a deep coin set is ~700KB of JSON, which localStorage
// holds as UTF-16 and hands back as a string — every boot parsed it, every
// save stringified it (several times, ~100ms each on a phone). IndexedDB
// structured-clones the object as-is, bytes stay bytes, and the write is
// write-behind: coalesced and asynchronous, flushed immediately when the page
// hides so nothing is lost to a suspend.
//
// Records keep today's localStorage keys (`btc-wallet-cache:<id>:ark…`) so
// the wallet-wipe prefix logic still applies. Existing localStorage copies
// migrate on first open (newest `_rev` wins) and are removed only after the
// IndexedDB write completed. If IndexedDB is unavailable the store falls
// back to localStorage exactly as before.

import { vtxoBytesToStr, vtxoBytesFromStr } from './proto.js';

const DB = 'coinos-ark';
const STORE = 'states';
const VERSION = 1;
export const ARK_KEY_RE = /^btc-wallet-cache:[0-9a-f]+:ark(:|$)/;
const DEBOUNCE_MS = 200;

// ---- backends ------------------------------------------------------------
export function idbBackend() {
  if (typeof indexedDB === 'undefined') return null;
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch {} dbp = null; };
        db.onclose = () => { dbp = null; };
        resolve(db);
      };
      req.onerror = () => { dbp = null; reject(req.error); };
      req.onblocked = () => { dbp = null; reject(new Error('IndexedDB blocked')); };
    });
    return dbp;
  };
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let out;
      try { out = fn(t.objectStore(STORE)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && typeof out.then === 'function' ? undefined : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  };
  return {
    async list() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const s = t.objectStore(STORE);
        const keys = s.getAllKeys(), vals = s.getAll();
        t.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
        t.onerror = () => reject(t.error);
      });
    },
    write(puts, dels) {
      if (!puts.length && !dels.length) return Promise.resolve();
      return run('readwrite', (s) => { for (const [k, v] of puts) s.put(v, k); for (const k of dels) s.delete(k); });
    },
  };
}
// For tests: the same contract over a Map.
export function memoryBackend(initial = []) {
  const m = new Map(initial);
  return {
    writes: 0,
    async list() { return [...m]; },
    async write(puts, dels) { this.writes++; for (const [k, v] of puts) m.set(k, structuredClone(v)); for (const k of dels) m.delete(k); },
    dump() { return m; },
  };
}

// ---- on-disk shape: coins' bytes as raw bytes -------------------------------
function toDisk(v) {
  if (!v || !Array.isArray(v.vtxos)) return v;
  return { ...v, vtxos: v.vtxos.map((x) => (typeof x.bytes === 'string' ? { ...x, bytes: vtxoBytesFromStr(x.bytes) } : x)) };
}
function fromDisk(v) {
  if (!v || !Array.isArray(v.vtxos)) return v;
  return { ...v, vtxos: v.vtxos.map((x) => (x.bytes instanceof Uint8Array ? { ...x, bytes: vtxoBytesToStr(x.bytes) } : x)) };
}
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

// ---- the store ---------------------------------------------------------------
export class ArkStore {
  constructor({ backend = idbBackend(), ls = () => globalThis.localStorage, now = Date.now } = {}) {
    this.backend = backend;   // null → localStorage mode (today's behaviour)
    this.ls = ls;
    this.now = now;
    this.mem = new Map();
    this.dirty = new Set();
    this.ready = !backend;    // localStorage mode needs no opening
    this.timer = 0;
    this.opening = null;
    this._flushing = null;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
      addEventListener('pagehide', () => this.flush());
    }
  }
  get lsMode() { return !this.backend; }

  // Load everything into memory, then fold in (and later retire) any
  // localStorage copies. The fold-in is synchronous after the async read, so
  // no write can slip between "what localStorage held" and "ready".
  open() {
    if (this.ready) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = (async () => {
      let rows;
      try { rows = await this.backend.list(); } catch (e) {
        this.backend = null; this.ready = true; // IndexedDB refused: stay on localStorage
        return;
      }
      for (const [k, v] of rows) this.mem.set(k, fromDisk(v));
      const migrated = [];
      const ls = this.ls();
      if (ls) {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (!k || !ARK_KEY_RE.test(k)) continue;
          let v; try { v = JSON.parse(ls.getItem(k)); } catch { continue; }
          if (!v || typeof v !== 'object') continue;
          const cur = this.mem.get(k);
          if (!cur || (v._rev || 0) >= (cur._rev || 0)) { this.mem.set(k, v); this.dirty.add(k); }
          migrated.push(k);
        }
      }
      this.ready = true;
      if (migrated.length) {
        this.flush().then(() => { for (const k of migrated) { try { ls.removeItem(k); } catch {} } }).catch(() => {});
      }
    })();
    return this.opening;
  }

  get(key) {
    if (!this.ready || this.lsMode) {
      try { const raw = this.ls().getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
    }
    const v = this.mem.get(key);
    return v ? clone(v) : null;
  }
  set(key, obj) {
    if (!this.ready || this.lsMode) { try { this.ls().setItem(key, JSON.stringify(obj)); } catch {} return; }
    this.mem.set(key, obj);
    this.dirty.add(key);
    this._schedule();
  }
  remove(key) {
    if (!this.ready || this.lsMode) { try { this.ls().removeItem(key); } catch {} return; }
    this.mem.delete(key);
    this.dirty.add(key);
    this._schedule();
  }
  keys(prefix = '') {
    if (!this.ready || this.lsMode) {
      const out = []; const ls = this.ls();
      try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix) && ARK_KEY_RE.test(k)) out.push(k); } } catch {}
      return out;
    }
    return [...this.mem.keys()].filter((k) => k.startsWith(prefix));
  }
  // Wallet wipe: everything under the wallet's cache-key prefix, wherever it lives.
  removePrefix(prefix) {
    for (const k of this.keys(prefix)) this.remove(k);
    const ls = this.ls();
    try {
      const gone = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix) && ARK_KEY_RE.test(k)) gone.push(k); }
      for (const k of gone) ls.removeItem(k);
    } catch {}
  }

  _schedule() {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) { this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, DEBOUNCE_MS);
  }
  // Write every dirty key in one transaction. A failed write keeps the keys
  // dirty for the next attempt; the in-memory copy is always authoritative.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    if (!this.ready || this.lsMode || !this.dirty.size) return this._flushing || Promise.resolve();
    if (this._flushing) return this._flushing.then(() => this.flush());
    const keys = [...this.dirty]; this.dirty.clear();
    const puts = [], dels = [];
    for (const k of keys) { if (this.mem.has(k)) puts.push([k, toDisk(this.mem.get(k))]); else dels.push(k); }
    this._flushing = this.backend.write(puts, dels)
      .catch(() => { for (const k of keys) this.dirty.add(k); })
      .finally(() => { this._flushing = null; });
    return this._flushing;
  }
}

let shared = null;
export function arkStore() {
  if (!shared) { shared = new ArkStore(); shared.open().catch(() => {}); }
  return shared;
}
