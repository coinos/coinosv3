import { PUBLIC_FEED_RELAYS, popularCandidates } from '../src/popular-feed.js';
import { isMachinePost } from '../src/lang-guess.js';

// One snapshot for all languages; language/mute filtering stays in the browser.
export async function buildSnapshot(query, now = Date.now) {
  const notes = new Map();
  let until;
  for (let round = 0; round < 3; round++) {
    const reactions = await query({ kinds: [6, 7, 9735], limit: 600, ...(until ? { until } : {}) });
    if (!reactions.length) break;
    until = Math.min(...reactions.map((e) => e.created_at)) - 1;
    const candidates = popularCandidates(reactions);
    const batches = [];
    for (let i = 0; i < candidates.ids.length; i += 40) batches.push(query({ ids: candidates.ids.slice(i, i + 40) }));
    for (const e of (await Promise.all(batches)).flat()) {
      if (candidates.qualifies(e) && !isMachinePost(e.content) && JSON.stringify(e).length <= 32_000) notes.set(e.id, e);
    }
  }
  if (!notes.size) throw new Error('No public posts returned; retaining previous snapshot');
  const posts = [...notes.values()].sort((a, b) => b.created_at - a.created_at);
  const authors = [...new Set(posts.map((e) => e.pubkey))];
  const profiles = new Map();
  for (let i = 0; i < authors.length; i += 100) {
    for (const e of await query({ kinds: [0], authors: authors.slice(i, i + 100) })) {
      if (e.kind === 0 && authors.includes(e.pubkey) && JSON.stringify(e).length <= 32_000
        && (!profiles.has(e.pubkey) || profiles.get(e.pubkey).created_at < e.created_at)) profiles.set(e.pubkey, e);
    }
  }
  return { version: 1, generatedAt: now(), notes: posts, profiles: [...profiles.values()], popUntil: until + 1 };
}

// Single flight, stale-while-refresh, and a retry delay when relays are down.
export function createSnapshotCache({ build, initial = null, save = async () => {}, now = Date.now, ttl = 60_000, maxAge = 86400_000, onError = console.error }) {
  let snapshot = initial, pending = null, retryAt = 0;
  function refresh() {
    if (pending) return pending;
    if (now() < retryAt) return Promise.resolve();
    pending = Promise.resolve().then(build).then(async (next) => {
      snapshot = next;
      await save(next);
    }).catch(onError).finally(() => { pending = null; retryAt = now() + 15_000; });
    return pending;
  }
  function read() {
    if (!snapshot || now() - snapshot.generatedAt >= ttl) void refresh();
    return snapshot && now() - snapshot.generatedAt <= maxAge ? snapshot : null;
  }
  return { read, refresh };
}

export function snapshotResponse(cache, req) {
  if (!['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const snapshot = cache.read();
  if (!snapshot) return new Response(null, { status: 503, headers: { 'Retry-After': '15', 'Cache-Control': 'no-store' } });
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(snapshot), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15, stale-while-revalidate=60' },
  });
}
export { PUBLIC_FEED_RELAYS };
