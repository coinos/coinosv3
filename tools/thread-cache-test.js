// Persistent thread context and the actual thread loader, with relay queries
// controlled in-process. No browser, network access, or publishing required.
// Run: bun tools/thread-cache-test.js
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createThreadStore } from '../src/thread-cache.js';
const memory = () => {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
};
const storage = memory();
globalThis.localStorage = storage;
const id = (n) => n.toString(16).padStart(64, '0');
const note = (n, tags = []) => ({ id: id(n), pubkey: id(900), kind: 1, content: 'Post ' + n, created_at: n, tags });
const root = note(1), parent = note(2, [['e', root.id, '', 'reply']]), reply = note(3, [['e', parent.id, '', 'reply']]);
const check = (name, fn) => { fn(); console.log('✓ ' + name); };
const store = createThreadStore(storage);
check('a fresh store restores full content and tags by any viewed event', () => {
  const long = { ...reply, content: 'x'.repeat(5000), tags: [...reply.tags, ['emoji', 'wave', 'https://example.com/wave.png']] };
  store.save({ root, replies: [parent, long] }, long.id);
  const restored = createThreadStore(storage).find(long.id);
  assert.deepEqual(restored, { rootId: root.id, root, replies: [long, parent] });
  assert.equal(store.find(parent.id).root.id, root.id);
});
check('a large thread retains the selected reply and its ancestors', () => {
  const siblings = Array.from({ length: 200 }, (_, i) => note(1000 + i, [['e', root.id, '', 'root']]));
  store.save({ root, replies: [...siblings, parent, reply] }, reply.id);
  const saved = store.find(reply.id);
  assert(saved.replies.some((e) => e.id === parent.id));
  assert(saved.replies.length < 160);
});
check('the thread cache is bounded and recent conversations win', () => {
  for (let i = 10; i < 30; i++) store.save({ root: note(i), replies: [] }, id(i));
  assert.equal(store.find(root.id), null);
  assert.equal(store.find(id(10)), null);
  assert(store.find(id(29)));
});
check('corrupt or unavailable storage does not break opening a thread', () => {
  assert.equal(createThreadStore({ getItem: () => '{' }).find(root.id), null);
  assert.equal(createThreadStore({ getItem: () => JSON.stringify([{ root: { ...root, tags: null }, replies: [] }]) }).find(root.id), null);
  assert.doesNotThrow(() => createThreadStore({ getItem() { throw Error(); }, setItem() { throw Error(); } }).save({ root, replies: [] }, root.id));
});

// Expose the real loader only in this test bundle, as the browser tests do.
const bundle = await Bun.build({ entrypoints: ['src/features/messages.js'], target: 'bun', plugins: [{ name: 'thread-cache-test', setup(build) {
  build.onLoad({ filter: /src\/features\/messages\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace("id: 'messages',", "id: 'messages', testThread: threadFor, testOpen: openNoteRef,") }));
  build.onLoad({ filter: /src\/nostr\.js$/ }, async ({ path }) => ({ loader: 'js', contents: (await Bun.file(path).text())
    .replace('export async function queryOn(relays, filter, maxWait = 1500) {', 'export async function queryOn(relays, filter, maxWait = 1500) { return globalThis.__threadQuery(filter);')
    .replace(/export function subscribeOn\(([^)]*)\) \{/, 'export function subscribeOn($1) { return () => {};') }));
} }] });
assert(bundle.success, bundle.logs.join('\n'));
const path = '/tmp/coinos-thread-cache-test-' + process.pid + '.mjs';
await Bun.write(path, await bundle.outputs[0].text());
try {
  const { messagesFeature } = await import(path);
  let requests = [], waiting = [];
  globalThis.__threadQuery = (filter) => {
    if (filter.kinds?.includes(1) && (filter.ids || filter['#e'])) {
      requests.push(filter);
      return new Promise((resolve) => waiting.push({ filter, resolve }));
    }
    return Promise.resolve([]);
  };
  const makeFeature = () => {
    const ui = { screen: 'wallet' };
    const feature = messagesFeature({ ui, wallet: { loaded: true, nostrRelays: () => [], loadFeatureState: (k, d) => d, saveFeatureState() {} },
      h() {}, render() {}, toast() {}, hook() {} });
    return { feature, ui };
  };
  // Use new IDs, so none of the storage-only tests can seed this lookup.
  const r = note(400), p = note(401, [['e', r.id, '', 'reply']]), e = note(402, [['e', p.id, '', 'reply']]);
  const first = makeFeature();
  const loading = first.feature.testThread(e);
  assert.equal(loading.status, 'loading');
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(5); }
    assert(condition(), 'expected loader progress');
  };
  await wait(() => waiting.length === 2);
  for (const q of waiting.splice(0)) q.resolve(q.filter.ids ? [p] : []);
  await wait(() => waiting.length === 2);
  for (const q of waiting.splice(0)) q.resolve(q.filter.ids ? [r] : []);
  await wait(() => loading.status === 'ready');
  check('the loader persists the discovered root and intermediate ancestor', () => {
    const cached = store.find(e.id);
    assert.equal(cached.rootId, r.id);
    assert(cached.replies.some((x) => x.id === p.id));
    assert(cached.replies.some((x) => x.id === e.id));
  });
  requests = [];
  const refreshed = makeFeature();
  refreshed.ui.noteThread = { rootId: p.id, focusId: e.id, seed: e };
  const restored = refreshed.feature.testThread(e);
  check('refresh returns the complete thread synchronously with no loading state', () => {
    assert.equal(restored.status, 'ready');
    assert.equal(restored.root.id, r.id);
    assert(restored.replies.some((x) => x.id === p.id));
    assert(restored.replies.some((x) => x.id === e.id));
    assert.equal(refreshed.ui.noteThread.rootId, r.id);
  });
  await wait(() => waiting.length === 1);
  check('background refresh asks for replies to the canonical root', () => {
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]['#e'], [r.id]);
  });
  for (const q of waiting.splice(0)) q.resolve([]);
  await Bun.sleep(20);
  check('an empty relay refresh preserves locally cached context', () => {
    assert.equal(restored.root.id, r.id);
    assert.equal(restored.replies.length, 2);
  });
  const deepLink = makeFeature();
  requests = [];
  await deepLink.feature.testOpen({ id: e.id });
  check('a cached note reference opens immediately without an event lookup', () => {
    assert.equal(deepLink.ui.noteThread.seed.id, e.id);
    assert.equal(requests.length, 0);
  });
} finally { await rm(path, { force: true }); }
