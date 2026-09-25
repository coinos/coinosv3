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
assert.equal(cache.read('following').length, 0);
assert.equal([...values.keys()].filter((k) => k.includes('feedNotes')).length, 4);
cache.read('custom1');
cache.save('custom5', notes);
assert.equal(cache.read('custom2').length, 0);
cache.save('big', notes.map((e) => ({ ...e, content: 'x'.repeat(15000) })));
assert([...values].filter(([k]) => k.includes('feedNotes')).reduce((n, [, v]) => n + v.length, 0) <= 256000);
time += 8 * 86400_000;
assert.equal(cache.read('big').length, 0);
assert.equal(storage.getItem('wallet:funds'), 'untouched');
console.log('✓ legacy caches shrink; 30 posts/feed, four feeds, byte budget, LRU and seven-day expiry enforced');
