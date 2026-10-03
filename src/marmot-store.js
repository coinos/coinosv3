// Where White Noise (Marmot) state lives: IndexedDB, one record per group.
//
// MLS state is the opposite of everything else this wallet keeps: it cannot
// be refetched or rederived (a lost ratchet is a lost group), it holds
// Uint8Arrays by the dozen (structured clone stores them as-is, JSON would
// triple them), and it is DEVICE state — two devices replaying one leaf's
// ratchet would reuse keys. So it stays out of the localStorage feature
// state and out of the cross-device sync, in a store of its own.
//
// Records are scoped by `scope` (wallet cache key + nostr identity), so two
// wallets or two identities on one browser never read each other's groups.

const DB = 'coinos-marmot';
const STORE = 'kv';

let dbP = null;
function db() {
  if (!dbP)
    dbP = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        // another tab upgrading or deleting the database must not be blocked
        req.result.onversionchange = () => { req.result.close(); dbP = null; };
        resolve(req.result);
      };
      req.onerror = () => { dbP = null; reject(req.error); };
    });
  return dbP;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let out;
    try { out = fn(t.objectStore(STORE)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function marmotStore(scope) {
  const pre = scope + '|';
  const range = () => IDBKeyRange.bound(pre, pre + '￿');
  return {
    // every record of this scope: Map(name -> value)
    async all() {
      const out = new Map();
      await tx('readonly', (s) => {
        const cur = s.openCursor(range());
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          out.set(String(c.key).slice(pre.length), c.value);
          c.continue();
        };
      });
      return out;
    },
    put: (name, value) => tx('readwrite', (s) => { s.put(value, pre + name); }),
    del: (name) => tx('readwrite', (s) => { s.delete(pre + name); }),
    wipe: () => tx('readwrite', (s) => { s.delete(range()); }),
  };
}

// Drop every scope under a wallet (the account-wipe hook).
export function wipeMarmot(walletKey) {
  return tx('readwrite', (s) => { s.delete(IDBKeyRange.bound(walletKey, walletKey + '￿')); }).catch(() => {});
}
