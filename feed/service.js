import { SimplePool } from 'nostr-tools/pool';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildSnapshot, createSnapshotCache, PUBLIC_FEED_RELAYS } from './cache.js';

export async function startFeedCache() {
  const file = process.env.FEED_CACHE_FILE || new URL('../db/public-feed.json', import.meta.url).pathname;
  let initial = null;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.version === 1 && Number.isFinite(data.generatedAt) && Array.isArray(data.notes) && data.notes.length && Array.isArray(data.profiles)) initial = data;
  } catch {}
  // SimplePool verifies signatures and matches filters before accepting events.
  const pool = new SimplePool();
  const cache = createSnapshotCache({
    initial,
    build: () => buildSnapshot((filter) => pool.querySync(PUBLIC_FEED_RELAYS, filter, { maxWait: 4500 })),
    save: async (data) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(data));
      await rename(file + '.tmp', file);
    },
    onError: (e) => console.warn('[public feed]', e.message),
  });
  cache.read(); // warm before the first visitor, reusing the persisted snapshot
  const timer = setInterval(() => cache.read(), 15_000);
  timer.unref();
  return cache;
}
