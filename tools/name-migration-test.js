// Exercise the real username submission handlers with mocked registrar and
// legacy responses. No names are registered and no profiles are published.
// Run: bun tools/name-migration-test.js
import assert from 'node:assert/strict';
import { namesFeature } from '../src/features/names.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: k => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
};
const originalFetch = globalThis.fetch;
const h = (tag, props, ...children) => ({ tag, props, children: children.flat().filter(x => x != null) });
const nodes = n => typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [];
const text = n => typeof n === 'object' ? n.children.map(text).join('') : String(n);
const migration = tree => nodes(tree).find(n => n.tag === 'button' && /Migrate an existing/.test(text(n)));

function setup({ error = 'name is taken', record, user, unavailable, network = 'mainnet', pending } = {}) {
  storage.set('btc-wallet-network', network);
  const ui = { nameClaim: 'legacy', screen: 'wallet', nameEditOpen: true };
  const calls = [];
  const state = { name: 'npub1test', domain: network === 'mainnet' ? 'coinos.io' : 'staging.coinos.io' };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    if (url.endsWith('/register')) {
      if (opts.method === 'DELETE') return Response.json({});
      return Response.json(error ? { error } : {}, { status: error ? 409 : 200 });
    }
    if (url.includes('/name/')) {
      if (pending) await pending;
      if (unavailable) throw new Error('offline');
      return Response.json(record ?? { name: 'legacy', domain: 'coinos.io', taken: true, reserved: true });
    }
    if (url.includes('/api/users/')) return user ? Response.json(user) : new Response('', { status: 404 });
    throw new Error('unexpected request: ' + url);
  };
  const feature = namesFeature({
    h, ui, render() {}, toast() {}, brandHeader: () => null,
    wallet: {
      nostrPubkey: () => 'a'.repeat(64), nostrSign: async e => e,
      loadFeatureState: () => state, saveFeatureState() {},
    },
    hook: name => name === 'arkStaticAddress' ? 'ark-test-address' : null,
  });
  const form = () => feature.namesClaimForm();
  const submit = () => nodes(form()).find(n => n.tag === 'button' && n.props.class === 'btn-primary btn-block').props.onClick();
  return { ui, calls, feature, form, submit };
}

try {
  let s = setup({ user: { username: 'legacy', migrated: true } });
  assert.equal(migration(s.form()), undefined);
  assert.equal(migration(s.feature.screenView()), undefined);
  assert.equal(s.calls.length, 0, 'opening the form does not check migration');
  await s.submit();
  assert.ok(migration(s.form()), 'legacy-only name offers migration after rejection');
  s.ui.onb = { step: 'spend' };
  migration(s.form()).props.onClick();
  assert.equal(s.ui.onb.step, 'legacy', 'onboarding still reaches the migration instructions');
  nodes(s.form()).find(n => n.tag === 'input').props.onInput({ target: { value: 'different' } });
  assert.equal(migration(s.form()), undefined, 'editing the name removes the offer');
  console.log('✓ migration is offered only after submitting a confirmed legacy-only name');

  s = setup({ error: null });
  await s.submit();
  assert.equal(migration(s.form()), undefined);
  assert.ok(s.calls.every(url => url.endsWith('/register')), 'successful claims skip migration lookups');
  console.log('✓ free names claim normally without a migration prompt');

  s = setup({ record: { name: 'legacy', domain: 'coinos.io', taken: true, pubkey: 'b'.repeat(64) }, user: { username: 'legacy' } });
  await s.submit();
  assert.equal(migration(s.form()), undefined);
  assert.ok(!s.calls.some(url => url.includes('/api/users/')), 'already registered names never offer migration');
  console.log('✓ migrated and other v3 names show the claim error without migration');

  for (const options of [{ error: 'name is reserved' }, { unavailable: true }, { user: { username: 'someoneelse' } },
    { record: {} }, { network: 'mutinynet', user: { username: 'legacy' } }, { error: 'signing timed out', user: { username: 'legacy' } }]) {
    s = setup(options);
    await s.submit();
    assert.equal(migration(s.form()), undefined);
  }
  console.log('✓ reserved words, failed lookups, staging, and unrelated errors do not offer migration');

  let release;
  s = setup({ user: { username: 'legacy' }, pending: new Promise(r => { release = r; }) });
  const submission = s.submit();
  s.ui.nameClaim = 'different';
  release();
  await submission;
  assert.equal(migration(s.form()), undefined, 'a late result cannot offer migration for a new draft');
  console.log('✓ editing during submission cannot leave a stale migration offer');

  s = setup({ error: 'name is reserved', user: { username: 'legacy', migrated: true } });
  await assert.rejects(s.feature.namesClaimName('legacy', { quietProfile: true }), err => err.migrationName === 'legacy');
  console.log('✓ profile saves receive the same confirmed migration result');
} finally {
  globalThis.fetch = originalFetch;
}
process.exit(0);
