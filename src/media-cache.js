// The feed's pictures and videos, kept apart from its posts. The feed cache
// holds a page of posts; a grid of clips needs hundreds of posts' worth, and
// re-reading the relays for them on every visit was most of why Videos was
// slow. So each feed keeps, per kind, the posts that carry media (compact:
// no tags but imeta), plus how far back it has looked — a reload paints the
// grid from here at once and the crawl resumes where it stopped.
//
// IndexedDB: a few hundred posts per feed and kind is too much for
// localStorage, and none of it is precious (it can always be re-read).

const DB = 'coinos-media';
const STORE = 'kv';
export const MEDIA_KEEP = 400; // posts per feed and kind

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

// what a grid needs of a post: who, when, the words, and its imeta
export const compactMediaEvent = (e) => ({
  id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, content: String(e.content || '').slice(0, 2000),
  tags: (e.tags || []).filter((x) => x[0] === 'imeta'), sig: e.sig,
});

// { images: [...], videos: [...] (newest first), until: oldest created_at looked at, end: when the bottom was hit }
export async function loadMediaIndex(key) {
  try { return (await tx('readonly', (s) => s.get(key))) || null; } catch { return null; }
}
export async function saveMediaIndex(key, rec) {
  try {
    await tx('readwrite', (s) => {
      s.put({ ...rec, images: (rec.images || []).slice(0, MEDIA_KEEP).map(compactMediaEvent),
        videos: (rec.videos || []).slice(0, MEDIA_KEEP).map(compactMediaEvent), at: Date.now() }, key);
    });
  } catch {}
}
export function wipeMediaIndex() {
  return tx('readwrite', (s) => { s.clear(); }).catch(() => {});
}
