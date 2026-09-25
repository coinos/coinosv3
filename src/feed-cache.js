// Disposable public feed cache. Budget is conservative UTF-16 storage bytes.
export const FEED_CACHE_POSTS = 30;
const MAX_FEEDS = 4, MAX_UNITS = 256_000, MAX_AGE = 7 * 86400_000;
export function createFeedCache(storage, prefix, now = Date.now) {
  const keyOf = (id) => id === 'following' ? prefix : prefix + ':' + id;
  const valid = (e) => e?.kind === 1 && typeof e.id === 'string' && typeof e.pubkey === 'string'
    && typeof e.content === 'string' && Number.isFinite(e.created_at) && Array.isArray(e.tags);
  function compact(notes) {
    const kept = []; let size = 0;
    for (const e of (Array.isArray(notes) ? notes : []).filter(valid).sort((a, b) => b.created_at - a.created_at)) {
      const cost = JSON.stringify(e).length;
      if (size + cost > MAX_UNITS - 1000) continue;
      kept.push(e); size += cost;
      if (kept.length === FEED_CACHE_POSTS) break;
    }
    return kept;
  }
  function sweep(preferred) {
    const entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== prefix && !key?.startsWith(prefix + ':')) continue;
      try {
        const text = storage.getItem(key);
        const raw = JSON.parse(text);
        const entry = Array.isArray(raw) ? { at: now(), notes: compact(raw) } : raw;
        if (!entry || !Number.isFinite(entry.at) || now() - entry.at > MAX_AGE) entries.push({ key });
        else entries.push({ key, text, value: { at: entry.at, notes: compact(entry.notes) } });
      } catch { entries.push({ key }); }
    }
    entries.sort((a, b) => (b.key === preferred) - (a.key === preferred) || (b.value?.at || 0) - (a.value?.at || 0));
    let units = 0, count = 0;
    for (const e of entries) {
      const json = e.value && JSON.stringify(e.value);
      if (!json || count >= MAX_FEEDS || units + json.length > MAX_UNITS) storage.removeItem(e.key);
      else { if (e.text !== json) storage.setItem(e.key, json); units += json.length; count++; }
    }
  }
  return {
    read(id) {
      try {
        sweep(keyOf(id));
        const value = JSON.parse(storage.getItem(keyOf(id)) || 'null');
        if (!value) return [];
        value.at = now(); storage.setItem(keyOf(id), JSON.stringify(value));
        return value.notes;
      } catch { return []; }
    },
    save(id, notes) {
      try { storage.setItem(keyOf(id), JSON.stringify({ at: now(), notes: compact(notes) })); sweep(keyOf(id)); } catch {}
    },
  };
}
