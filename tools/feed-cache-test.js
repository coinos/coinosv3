import assert from 'node:assert/strict';
import { createFeedCache } from '../src/feed-cache.js';
const values = new Map();
const storage = { get length() { return values.size; }, key: (i) => [...values.keys()][i],
  getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
let time = 1000;
const cache = createFeedCache(storage, 'wallet:feedNotes', () => time++);
const notes = Array.from({ length: 50 }, (_, i) => ({ id: String(i), pubkey: 'author', kind: 1,
  created_at: 100 - i, content: 'post', tags: [] }));
storage.setItem('wallet:feedNotes', JSON.stringify(notes));
storage.setItem('wallet:funds', 'untouched');
assert.equal(cache.read('following').length, 30);
assert.equal(JSON.parse(storage.getItem('wallet:feedNotes')).notes.length, 30);
for (let i = 0; i < 5; i++) cache.save('custom' + i, notes);
const stored = (id) => JSON.parse(storage.getItem(id === 'following' ? 'wallet:feedNotes' : 'wallet:feedNotes:' + id) || 'null');
assert.equal(stored('following').notes.length, 5, 'a feed past the four most recent keeps seed posts');
assert.equal(stored('custom4').notes.length, 30);
assert.equal(cache.read('following').length, 5, 'and reads them back');
for (let i = 5; i < 14; i++) cache.save('custom' + i, notes);
assert.equal([...values.keys()].filter((k) => k.includes('feedNotes')).length, 12);
assert.equal(stored('custom0'), null, 'the least recently read goes first');
assert.equal(stored('custom3').notes.length, 5);
cache.read('custom3'); cache.save('custom3', notes);
assert.equal(stored('custom3').notes.length, 30, 'reopened, it gets a full page again');
assert.equal(stored('custom10').notes.length, 5, 'and the oldest of the four drops to seed posts');
// seeds warmed ahead never outrank or overwrite a feed that was read
cache.seed('custom13', notes.slice(0, 2));
assert.equal(stored('custom13').notes.length, 30);
assert.equal(cache.has('warm'), false);
cache.seed('warm', notes);
assert.equal(cache.has('warm'), true);
assert.equal(stored('warm').notes.length, 5);
assert.equal(stored('custom13').notes.length, 30);
cache.save('big', notes.map((e) => ({ ...e, content: 'x'.repeat(15000) })));
assert([...values].filter(([k]) => k.includes('feedNotes')).reduce((n, [, v]) => n + v.length, 0) <= 256000);
time += 8 * 86400_000;
assert.equal(cache.read('big').length, 0);
assert.equal(storage.getItem('wallet:funds'), 'untouched');
console.log('✓ legacy caches shrink; 30 posts for the four most recent feeds, 5 seed posts for up to 12, byte budget, LRU and seven-day expiry enforced');
