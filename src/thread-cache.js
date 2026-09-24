// Public kind-1 thread context, available before wallet unlock as well as
// inside a wallet. Keep complete event text/tags; truncating a cached event
// would make the content change when a relay answered after the first paint.
const KEY = 'btc-wallet-note-threads';
const MAX_THREADS = 12;
const MAX_EVENTS = 160;
const MAX_BYTES = 1_000_000; // JSON code units; at most about 2 MB in storage
const validNote = (e) => e?.kind === 1 && typeof e.id === 'string'
  && /^[0-9a-f]{64}$/.test(e.id) && typeof e.pubkey === 'string'
  && /^[0-9a-f]{64}$/.test(e.pubkey) && typeof e.content === 'string'
  && Number.isFinite(e.created_at) && Array.isArray(e.tags)
  && e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'));
const savedNote = ({ id, pubkey, kind, created_at, content, tags }) => ({ id, pubkey, kind, created_at, content, tags });

export function createThreadStore(storage) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const read = () => {
    try {
      const raw = storage?.getItem(KEY);
      if (!raw || raw.length > MAX_BYTES) return [];
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter((c) => validNote(c?.root) && c.rootId === c.root.id
        && Array.isArray(c.replies) && c.replies.length < MAX_EVENTS
        && c.replies.every(validNote)).slice(0, MAX_THREADS);
    } catch { return []; }
  };
  return {
    find(id) {
      return read().find((c) => c.rootId === id || c.replies.some((e) => e.id === id)) || null;
    },
    save(thread, focusId) {
      if (!validNote(thread.root)) return;
      const events = new Map([thread.root, ...thread.replies.filter(validNote)].map((e) => [e.id, e]));
      const keep = new Map([[thread.root.id, thread.root]]);
      // The selected reply and every locally known ancestor get priority
      // over sibling replies when a large conversation needs trimming.
      const visit = (id) => {
        if (keep.has(id) || keep.size >= MAX_EVENTS) return;
        const e = events.get(id);
        if (!e) return;
        keep.set(id, e);
        for (const t of e.tags) if (t[0] === 'e' && t[3] !== 'mention') visit(t[1]);
      };
      visit(focusId);
      for (const e of events.values()) {
        if (keep.size >= MAX_EVENTS) break;
        visit(e.id);
      }
      const entry = { rootId: thread.root.id, root: savedNote(thread.root),
        replies: [...keep.values()].filter((e) => e.id !== thread.root.id).map(savedNote) };
      const entries = [entry, ...read().filter((c) => c.rootId !== entry.rootId)].slice(0, MAX_THREADS);
      let json = JSON.stringify(entries);
      while (json.length > MAX_BYTES && entries.length > 1) { entries.pop(); json = JSON.stringify(entries); }
      if (json.length > MAX_BYTES) return; // keep the previous cache if this thread alone is too large
      try { storage?.setItem(KEY, json); } catch {} // full/disabled storage must not break reading
    },
  };
}
