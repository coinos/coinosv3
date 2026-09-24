// Geometry/state regressions that don't require browser or network access.
// Run: bun tools/feed-window-test.js
import assert from 'node:assert/strict';
import { mergeFeedWindow } from '../src/feed-window.js';
const note = (id, at) => ({ id, created_at: at });
const notes = [note('a', 100), note('b', 90), note('c', 80), note('d', 70)];
const rows = (top) => notes.map((e, i) => ({ id: e.id, top: top + i * 200, bottom: top + (i + 1) * 200 }));
const above = note('above', 110), gap = note('gap', 95), below = note('below', 60);
const check = (name, fn) => { fn(); console.log('✓ ' + name); };
check('header-visible arrivals wait without changing the displayed window', () => {
  const r = mergeFeedWindow(notes, 4, [above, gap], { rows: rows(180), height: 844 });
  assert.equal(r.notes, notes);
  assert.equal(r.shown, 4);
  assert.deepEqual(r.deferred, [above, gap]);
});
check('offscreen prepends preserve every displayed post; visible gap fills wait', () => {
  const r = mergeFeedWindow(notes, 4, [above, gap, below], { rows: rows(-50), height: 844 });
  assert.deepEqual(r.added, [above, below]);
  assert.deepEqual(r.deferred, [gap]);
  assert.deepEqual(r.notes.slice(0, r.shown).map((e) => e.id), ['above', 'a', 'b', 'c', 'd']);
});
check('a deferred gap becomes available once it is above the viewport', () => {
  const r = mergeFeedWindow(notes, 4, [gap], { rows: rows(-450), height: 844 });
  assert.deepEqual(r.deferred, []);
  assert.deepEqual(r.notes.map((e) => e.id), ['a', 'gap', 'b', 'c', 'd']);
});
check('hidden posts cannot allow an insertion between visible posts', () => {
  const r = mergeFeedWindow([notes[0], note('hidden', 97), ...notes.slice(1)], 4, [note('gap', 98)], { rows: rows(-50), height: 844 });
  assert.equal(r.added.length, 0);
  assert.equal(r.deferred.length, 1);
});
check('equal timestamps retain their order and obey the visible-gap rule', () => {
  const r = mergeFeedWindow(notes, 4, [note('equal', 100)], { rows: rows(-50), height: 844 });
  assert.equal(r.added.length, 0);
  assert.equal(r.deferred[0].id, 'equal');
});
check('large catch-ups retain the reader at the cache boundary', () => {
  const old = Array.from({ length: 200 }, (_, i) => note('old' + i, 1000 - i));
  const news = Array.from({ length: 80 }, (_, i) => note('new' + i, 2000 - i));
  const r = mergeFeedWindow(old, 200, news);
  assert.equal(r.shown, 280);
  assert.equal(r.notes.at(-1).id, 'old199');
});
check('older-page requests still advance beyond the cache boundary', () => {
  const old = Array.from({ length: 200 }, (_, i) => note('old' + i, 1000 - i));
  const older = Array.from({ length: 40 }, (_, i) => note('older' + i, 500 - i));
  const r = mergeFeedWindow(old, 200, older);
  assert.equal(r.notes.length, 220);
  assert.equal(r.notes[200].id, 'older0');
});
check('duplicate arrivals cannot create repeated rows', () => {
  const r = mergeFeedWindow(notes, 4, [notes[0], above, above]);
  assert.equal(r.notes.length, 5);
  assert.deepEqual(r.added, [above]);
});
