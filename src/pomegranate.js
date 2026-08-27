// "Sign in with Google" via pomegranate (fiatjaf): the user's nostr key is
// FROST-sharded across independent operators, and a central server
// coordinates NIP-46 signing behind Google OAuth — nobody, central included,
// holds the whole key, yet the Google account alone recovers it (threshold
// shards come back from the operators' /po/recover/google). The output here
// is a plain bunker:// URI: the rest of the login is hal's ordinary bunker
// flow, so the wallet-seed backup (encrypted to the user's own key, on
// relays) works unchanged and Google recovers the wallet too.
//
// Dynamically imported (its FROST dealer dependency rides in this chunk) —
// nothing here loads before the button is pressed.
//
// Reference: https://viewsource.win/fiatjaf.com/pomegranate — the
// implementation-guide steps are numbered in comments below. The kind-16440
// cross-central discovery step is deliberately skipped: it needs argon2id for
// nothing while the ecosystem has a single central server.
import { sha256 } from '@noble/hashes/sha256';
import { hex } from '@scure/base';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { hexPubShard, hexShard, trustedKeyDeal } from '@jsr/fiatjaf__promenade-trusted-dealer';

export const CENTRAL = 'https://auth.njump.me';
const OPERATORS = [
  'https://po.f7z.io',
  'https://po.coracle.social',
  'https://po.njump.me',
  'https://po.jumble.social',
];
const THRESHOLD = 2;
const PICK = 3;

const api = (token) => async (path, opts = {}) => {
  const r = await fetch(CENTRAL + path, {
    ...opts,
    headers: { Authorization: 'Token ' + token, ...(opts.headers || {}) },
  });
  return r;
};

// Step 2-4: the popup is opened by the CALLER inside the click's user
// activation (a popup opened after our chunk finishes loading would be
// blocked); we point it at the login page and wait for the postMessage.
export function authenticate(popup) {
  return new Promise((resolve, reject) => {
    if (!popup) return reject(new Error('popup blocked'));
    popup.location = CENTRAL + '/login/google';
    const timer = setInterval(() => {
      if (popup.closed) { cleanup(); reject(new Error('login window closed')); }
    }, 500);
    const handler = (event) => {
      if (event.origin !== CENTRAL || !event.data || !event.data.token) return;
      cleanup();
      try { popup.close(); } catch {}
      resolve(event.data.token);
    };
    const cleanup = () => { clearInterval(timer); window.removeEventListener('message', handler); };
    window.addEventListener('message', handler);
  });
}

const emailOf = (token) => {
  try {
    const evt = JSON.parse(atob(token));
    return (evt.tags.find((t) => t[0] === 'email') || [])[1] || null;
  } catch { return null; }
};

// Steps 8-14: shard a fresh key across randomly-picked operators and register
// everywhere. The secret key exists only inside this function and is wiped on
// the way out — from here on the key lives as shards, nowhere whole.
async function createAccount(token, email, onStatus) {
  const ops = [...OPERATORS].sort(() => Math.random() - 0.5).slice(0, PICK);
  const session = crypto.randomUUID();
  const sk = generateSecretKey();
  try {
    onStatus && onStatus('splitting');
    const skBig = Array.from(sk).reduce((acc, b) => (acc << 8n) + BigInt(b), 0n);
    const { shards } = trustedKeyDeal(skBig, THRESHOLD, ops.length);

    onStatus && onStatus('registering');
    const regEvent = finalizeEvent({
      kind: 20445,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['threshold', String(THRESHOLD)],
        ...ops.map((op, i) => ['operator', op, hexPubShard(shards[i].pubShard)]),
      ],
      content: '',
    }, sk);
    const reg = await api(token)('/register', {
      method: 'POST',
      body: JSON.stringify(regEvent),
      headers: { 'Content-Type': 'application/json', 'X-Pomegranate-Session': session },
    });
    if (!reg.ok) throw new Error('central registration failed (' + reg.status + ')');

    for (let i = 0; i < ops.length; i++) {
      const opEvent = finalizeEvent({
        kind: 20444,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['central', CENTRAL], ['email', email]],
        content: hexShard(shards[i]),
      }, sk);
      const r = await fetch(ops[i] + '/po/register', {
        method: 'POST',
        body: JSON.stringify(opEvent),
        headers: {
          'Content-Type': 'application/json',
          'X-Pomegranate-Operator-Token': hex.encode(sha256(new TextEncoder().encode(session + ':' + ops[i]))),
        },
      });
      if (!r.ok) throw new Error('operator registration failed for ' + ops[i]);
    }
  } finally {
    sk.fill(0); // step 17
  }

  // the operators confirm with central in the background — wait for it
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const acc = await api(token)('/account');
    if (acc.ok) return acc.json();
  }
  throw new Error('operators did not confirm the account in time');
}

// Steps 15-16: a reusable "default" profile is the bunker.
async function bunkerUri(token) {
  const get = async () => {
    const r = await api(token)('/profiles');
    if (!r.ok) throw new Error('could not load signer profiles');
    return r.json();
  };
  let profiles = await get();
  if (!profiles.some((p) => p.name === 'default')) {
    const r = await api(token)('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'default' }),
    });
    if (!r.ok) throw new Error('could not create a signer profile');
    profiles = await get();
  }
  const def = profiles.find((p) => p.name === 'default') || profiles[0];
  if (!def) throw new Error('no signer profile available');
  return `bunker://${def.handler_pubkey}?relay=${encodeURIComponent(CENTRAL.replace('http', 'ws'))}`;
}

// The whole flow: authenticate, find-or-create the sharded account, hand back
// a bunker URI. `popup` must come from the caller's click handler.
export async function loginWithGoogle(popup, { onStatus } = {}) {
  const token = await authenticate(popup);
  const email = emailOf(token);
  if (!email) throw new Error('Google login returned no email');
  onStatus && onStatus('checking');
  const acc = await api(token)('/account');
  if (!acc.ok && acc.status !== 404 && acc.status !== 401) {
    throw new Error('signer server unavailable (' + acc.status + ')');
  }
  if (!acc.ok) await createAccount(token, email, onStatus);
  onStatus && onStatus('connecting');
  return { uri: await bunkerUri(token), email };
}
