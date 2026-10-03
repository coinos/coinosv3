// Marmot (White Noise) — MLS group chats over nostr
// https://github.com/marmot-protocol/marmot
//
// The protocol layer above mls.js: Marmot's app components, the account
// identity proof, the nostr event shapes (30443 KeyPackage, 444 Welcome,
// 445 group message) and the per-group engine that decides which MLS bytes
// become group state. Protocol-pure like concord.js: no DOM, no app state,
// no relay I/O. The messages feature drives it and owns storage and sockets.

import { sha256 } from "@noble/hashes/sha256";
import { expand } from "@noble/hashes/hkdf";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, concatBytes, randomBytes } from "@noble/hashes/utils";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { base64 } from "@scure/base";
import { finalizeEvent, generateSecretKey, getEventHash, verifyEvent } from "nostr-tools/pure";
import * as mls from "./mls.js";

export const KIND = { KEY_PACKAGE: 30443, WELCOME: 444, GROUP: 445, CHAT: 9, EDIT: 1009, REACTION: 7, DELETE: 5, SYSTEM: 1210 };

export const COMP = {
  APP_COMPONENTS: 0x0001,
  SAFE_AAD: 0x0002,
  LAST_RESORT: 0x0004,
  PROFILE: 0x8001,
  IMAGE: 0x8002,
  ADMINS: 0x8003,
  ROUTING: 0x8004,
  RETENTION: 0x8005,
  AGENT_STREAM: 0x8006,
  AVATAR_URL: 0x8007,
  MEDIA_V1: 0x8008,
  PROOF: 0x8009,
  MEDIA_V2: 0x800b,
  LIFECYCLE: 0x800c,
};

// The agent-stream "receive" role: we understand the component and settle for
// the durable final message. Groups made by White Noise require it.
const EXT_STREAM_RECEIVE = 0xf2d1;

// Components whose group state we can carry. Anything a group REQUIRES that
// is not here is a group we must not join; anything merely present is kept
// byte-for-byte by the MLS layer.
export const SUPPORTED = [
  COMP.PROFILE, COMP.IMAGE, COMP.ADMINS, COMP.ROUTING, COMP.RETENTION, COMP.AGENT_STREAM,
  COMP.AVATAR_URL, COMP.MEDIA_V1, COMP.PROOF, COMP.MEDIA_V2, COMP.LIFECYCLE,
];

// Convergence policy v1 (protocol constants, not preferences).
const MAX_REWIND = 5;
const PAST_EPOCHS = 5;

const KP_LIFETIME = 84 * 86400; // + the hour of skew below = the 7,261,200 s cap
const KP_SKEW = 3600;

const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder("utf-8", { fatal: true }).decode(b);
const now = () => Math.floor(Date.now() / 1000);
const EMPTY = new Uint8Array(0);

const cmp = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const same = (a, b) => a.length === b.length && cmp(a, b) === 0;

// ---- the Marmot binary profile: TLS structs with QUIC varint vectors ----

const u16 = (n) => Uint8Array.of(n >> 8, n & 255);
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const vlen = (n) =>
  n < 0x40 ? Uint8Array.of(n)
    : n < 0x4000 ? Uint8Array.of(0x40 | (n >> 8), n & 255)
      : Uint8Array.of(0x80 | (n >>> 24), (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const vec = (...parts) => {
  const b = concatBytes(...parts);
  return concatBytes(vlen(b.length), b);
};

class Rd {
  constructor(b) { this.b = b; this.i = 0; }
  get more() { return this.i < this.b.length; }
  take(n) {
    if (this.i + n > this.b.length) throw new Error("truncated");
    const o = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return o;
  }
  u8() { return this.take(1)[0]; }
  u16() { const b = this.take(2); return (b[0] << 8) | b[1]; }
  u64() { const b = this.take(8); return Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0)); }
  len() {
    const first = this.u8(), k = first >> 6;
    if (k === 3) throw new Error("vector too long");
    let n = first & 63;
    for (let j = (1 << k) - 1; j > 0; j--) n = n * 256 + this.u8();
    // canonical bytes only: a longer prefix for the same length is a different encoding
    if ((k === 1 && n < 0x40) || (k === 2 && n < 0x4000)) throw new Error("non-minimal length");
    return n;
  }
  vec() { return this.take(this.len()); }
  end() { if (this.more) throw new Error("trailing bytes"); }
}

// ---- app components ----

// AppDataDictionary (MLS extensions draft): entries sorted by id, unique.
export function dictDecode(data) {
  const r = new Rd(data);
  const body = new Rd(r.vec());
  r.end();
  const out = [];
  let prev = -1;
  while (body.more) {
    const id = body.u16();
    if (id <= prev) throw new Error("app_data_dictionary not sorted");
    prev = id;
    out.push({ id, data: body.vec() });
  }
  return out;
}
export const dictEncode = (entries) =>
  vec(...[...entries].sort((a, b) => a.id - b.id).flatMap((e) => [u16(e.id), vec(e.data)]));
const dictExt = (entries) => ({ type: mls.EXT.APP_DATA_DICTIONARY, data: dictEncode(entries) });
const dictOf = (extensions) => {
  const e = (extensions || []).find((x) => x.type === mls.EXT.APP_DATA_DICTIONARY);
  return e ? dictDecode(e.data) : [];
};
const comp = (extensions, id) => dictOf(extensions).find((e) => e.id === id)?.data;

const idList = {
  enc: (ids) => vec(...[...new Set(ids)].sort((a, b) => a - b).map(u16)),
  dec(data) {
    const r = new Rd(data), body = new Rd(r.vec()), out = [];
    r.end();
    while (body.more) out.push(body.u16());
    return out;
  },
};

const profile = {
  enc: ({ name = "", about = "" }) => concatBytes(vec(utf8(name)), vec(utf8(about))),
  dec(data) {
    const r = new Rd(data);
    const out = { name: text(r.vec()), about: text(r.vec()) };
    r.end();
    return out;
  },
};

const admins = {
  enc(list) {
    const keys = [...new Set(list)].map(hexToBytes).sort(cmp);
    if (!keys.length) throw new Error("a group needs an admin");
    return vec(...keys);
  },
  dec(data) {
    const r = new Rd(data), body = r.vec(), out = [];
    r.end();
    if (!body.length || body.length % 32) throw new Error("bad admin policy");
    for (let i = 0; i < body.length; i += 32) {
      const k = body.subarray(i, i + 32);
      if (i && cmp(body.subarray(i - 32, i), k) >= 0) throw new Error("admin policy not sorted");
      out.push(bytesToHex(k));
    }
    return out;
  },
};

// The Nostr relay URL profile: absolute ws(s) URL, a host, no credentials or fragment.
export function relayOk(url) {
  try {
    if (typeof url !== "string" || utf8(url).length > 512) return false;
    const u = new URL(url);
    return (u.protocol === "wss:" || u.protocol === "ws:") && !!u.hostname && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

const routing = {
  enc({ id, relays }) {
    const urls = [...new Set(relays)].filter(relayOk).map(utf8).sort(cmp).slice(0, 16);
    if (!urls.length) throw new Error("a group needs a relay");
    return concatBytes(hexToBytes(id), vec(...urls.map((u) => vec(u))));
  },
  dec(data) {
    const r = new Rd(data);
    const id = bytesToHex(r.take(32));
    const body = new Rd(r.vec()), relays = [];
    r.end();
    let prev = null;
    while (body.more) {
      const u = body.vec();
      if (prev && cmp(prev, u) >= 0) throw new Error("relay list not sorted");
      prev = u;
      relays.push(text(u));
    }
    if (!relays.length || relays.length > 16 || !relays.every(relayOk)) throw new Error("bad relay list");
    return { id, relays };
  },
};

// What a group's signed state says about itself. Throws on malformed state.
const viewMemo = new WeakMap();
export function groupView(state) {
  let v = viewMemo.get(state);
  if (v) return v;
  const d = dictOf(state.extensions);
  const get = (id) => d.find((e) => e.id === id)?.data;
  const p = get(COMP.PROFILE), a = get(COMP.ADMINS), r = get(COMP.ROUTING), l = get(COMP.LIFECYCLE), t = get(COMP.RETENTION);
  const req = get(COMP.APP_COMPONENTS);
  v = {
    ...(p ? profile.dec(p) : { name: "", about: "" }),
    admins: a ? admins.dec(a) : [],
    routing: r ? routing.dec(r) : null,
    disbanded: !!l && l.length === 1 && l[0] === 1,
    retention: t && t.length === 8 ? new Rd(t).u64() : 0,
    required: req ? idList.dec(req) : [],
  };
  viewMemo.set(state, v);
  return v;
}

// ---- account identity proof (component 0x8009) ----
// A normal signed nostr event (kind 450, never published) binds the account
// key to this device's MLS signature key; only signer_pubkey, created_at and
// the signature travel, and every verifier rebuilds the event around them.

const proofEvent = (pubkey, created_at, sigPub) => ({
  pubkey,
  created_at,
  kind: 450,
  tags: [
    ["d", "marmot.account-identity-proof.v2"],
    ["component", "0x8009"],
    ["ciphersuite", "0x0001"],
    ["signature_scheme", "0x0807"],
    ["mls_signature_key", bytesToHex(sigPub)],
  ],
  content: "Authorize this MLS leaf key for my Marmot account",
});

// signEvent: (unsigned event) -> signed event; a raw key or any login signer.
export async function makeProof(signEvent, pubkey, sigPub) {
  const want = proofEvent(pubkey, now(), sigPub);
  const got = await signEvent({ ...want });
  // a remote signer may hand back anything: accept only our exact event
  if (!got || got.pubkey !== pubkey || got.created_at !== want.created_at || got.kind !== 450 ||
      got.content !== want.content || JSON.stringify(got.tags) !== JSON.stringify(want.tags))
    throw new Error("signer changed the proof event");
  const id = getEventHash(want);
  if (got.id !== id || !schnorr.verify(got.sig, id, pubkey)) throw new Error("bad proof signature");
  return concatBytes(hexToBytes(pubkey), u64(want.created_at), hexToBytes(got.sig));
}

const proofMemo = new Map();
export function proofOk(proof, identity, sigPub) {
  if (!proof || proof.length !== 104 || !same(proof.subarray(0, 32), identity)) return false;
  const key = bytesToHex(proof) + bytesToHex(sigPub);
  let ok = proofMemo.get(key);
  if (ok === undefined) {
    try {
      const at = new Rd(proof.subarray(32, 40)).u64();
      const pubkey = bytesToHex(identity);
      ok = at >= 1 && schnorr.verify(proof.subarray(40), getEventHash(proofEvent(pubkey, at, sigPub)), pubkey);
    } catch { ok = false; }
    if (proofMemo.size > 2000) proofMemo.clear();
    proofMemo.set(key, ok);
  }
  return ok;
}

// A leaf is a Marmot member leaf when it advertises and carries a valid proof.
function leafOk(leaf) {
  const cred = leaf.credential;
  if (!cred || cred.type !== 1 || !cred.identity || cred.identity.length !== 32) return false;
  let d;
  try { d = dictOf(leaf.extensions); } catch { return false; }
  const list = d.find((e) => e.id === COMP.APP_COMPONENTS);
  try { if (!list || !idList.dec(list.data).includes(COMP.PROOF)) return false; } catch { return false; }
  return proofOk(d.find((e) => e.id === COMP.PROOF)?.data, cred.identity, leaf.signatureKey);
}

// ---- KeyPackages ----

export const capabilities = () => ({
  versions: [1],
  ciphersuites: [1],
  extensions: [mls.EXT.APP_DATA_DICTIONARY, EXT_STREAM_RECEIVE],
  proposals: [mls.PROPOSAL.APP_DATA_UPDATE, mls.PROPOSAL.SELF_REMOVE],
  credentials: [1],
});

// The same three entries White Noise puts on a leaf: what we support, an
// empty SafeAAD list, and the proof.
const leafExtensions = (proof) => [dictExt([
  { id: COMP.APP_COMPONENTS, data: idList.enc([COMP.APP_COMPONENTS, ...SUPPORTED]) },
  { id: COMP.SAFE_AAD, data: idList.enc([]) },
  { id: COMP.PROOF, data: proof },
])];

const lifetime = () => ({ notBefore: now() - KP_SKEW, notAfter: now() + KP_LIFETIME });

// A device's standing: its MLS signature key and the account's proof for it.
// One proof covers every KeyPackage and every group leaf made with this key,
// so a remote signer is asked exactly once per device.
export async function newDevice(signEvent, pubkey) {
  const sig = mls.generateSignatureKeyPair();
  return { pubkey, sig, proof: await makeProof(signEvent, pubkey, sig.pub), slot: bytesToHex(randomBytes(32)) };
}

// Last-resort by default: one published package has to survive several
// inviters finding it before we have been online to rotate it.
export function newKeyPackage(device, { lastResort = true } = {}) {
  const life = lifetime();
  const kp = mls.generateKeyPackage({
    sig: device.sig,
    identity: hexToBytes(device.pubkey),
    capabilities: capabilities(),
    leafExtensions: leafExtensions(device.proof),
    extensions: lastResort ? [dictExt([{ id: COMP.LAST_RESORT, data: EMPTY }])] : [],
    lifetime: life,
  });
  return { ref: bytesToHex(kp.ref), keyPackage: kp.keyPackage, message: kp.message, secrets: kp.secrets, notAfter: life.notAfter, lastResort };
}

const hex4 = (n) => "0x" + n.toString(16).padStart(4, "0");

// The unsigned kind-30443 event for a KeyPackage record; the account signs it.
export const keyPackageEvent = (device, kp) => ({
  kind: KIND.KEY_PACKAGE,
  pubkey: device.pubkey,
  created_at: now(),
  content: base64.encode(kp.message),
  tags: [
    ["d", device.slot],
    ["mls_protocol_version", "1.0"],
    ["i", kp.ref],
    ["mls_ciphersuite", "0x0001"],
    ["mls_extensions", ...capabilities().extensions.map(hex4)],
    ["mls_proposals", ...capabilities().proposals.map(hex4)],
    ["app_components", ...SUPPORTED.map(hex4)],
    // which app made it: lets a coinos wallet recognise another one
    ["client", "coinos"],
  ],
});

const one = (ev, name) => {
  const hits = ev.tags.filter((t) => t[0] === name);
  return hits.length === 1 && hits[0].length === 2 ? hits[0][1] : null;
};
const idTag = (ev, name) => {
  const hits = ev.tags.filter((t) => t[0] === name);
  if (hits.length !== 1 || hits[0].length < 2) return null;
  const vals = hits[0].slice(1);
  return vals.every((v) => /^0x[0-9a-f]{4}$/.test(v)) && new Set(vals).size === vals.length ? vals.map((v) => parseInt(v, 16)) : null;
};

// Validate somebody's published KeyPackage. Returns the candidate or null.
export function readKeyPackageEvent(ev, at = now()) {
  try {
    if (ev.kind !== KIND.KEY_PACKAGE || !verifyEvent(ev)) return null;
    const d = one(ev, "d"), i = one(ev, "i");
    if (!d || !/^[0-9a-f]{64}$/.test(d) || !i || one(ev, "mls_protocol_version") !== "1.0") return null;
    const suites = idTag(ev, "mls_ciphersuite"), comps = idTag(ev, "app_components");
    if (!suites || !suites.includes(1) || !idTag(ev, "mls_extensions") || !idTag(ev, "mls_proposals")) return null;
    if (!comps || !comps.includes(COMP.PROOF)) return null;
    const kp = mls.parseKeyPackage(base64.decode(ev.content));
    if (kp.cipherSuite !== 1 || bytesToHex(kp.ref) !== i) return null;
    if (bytesToHex(kp.leaf.credential.identity) !== ev.pubkey || !leafOk(kp.leaf)) return null;
    const life = kp.leaf.lifetime;
    if (!life || at < life.notBefore || at > life.notAfter || life.notAfter - life.notBefore > KP_LIFETIME + KP_SKEW) return null;
    const caps = kp.leaf.capabilities;
    if (!caps.extensions.includes(mls.EXT.APP_DATA_DICTIONARY) || !caps.proposals.includes(mls.PROPOSAL.APP_DATA_UPDATE)) return null;
    let lastResort = false;
    try { lastResort = dictOf(kp.extensions).some((e) => e.id === COMP.LAST_RESORT); } catch {}
    return {
      id: ev.id, pubkey: ev.pubkey, slot: d, ref: i, created_at: ev.created_at, lastResort,
      keyPackage: kp.keyPackage,
      components: idList.dec(comp(kp.leaf.extensions, COMP.APP_COMPONENTS)),
      extensions: caps.extensions, proposals: caps.proposals,
      client: ev.tags.find((t) => t[0] === "client")?.[1] || "",
    };
  } catch { return null; }
}

// One candidate per (author, slot) — the newest, lower id on a tie — then
// single-use packages before last-resort ones, fresher first, lower ref last.
export function pickKeyPackage(candidates) {
  const slots = new Map();
  for (const c of candidates) {
    const k = c.pubkey + c.slot, cur = slots.get(k);
    if (!cur || c.created_at > cur.created_at || (c.created_at === cur.created_at && c.id < cur.id)) slots.set(k, c);
  }
  return [...slots.values()].sort((a, b) =>
    (a.lastResort - b.lastResort) || (b.created_at - a.created_at) || (a.ref < b.ref ? -1 : 1))[0] || null;
}

// Can this KeyPackage join a group in this state?
export function fits(state, cand) {
  const v = groupView(state);
  return v.required.every((id) => cand.components.includes(id) || id === COMP.APP_COMPONENTS);
}

// ---- group state rules ----

const account = (m) => bytesToHex(m.identity);
export const roster = (state) => mls.members(state).map((m) => ({ leaf: m.index, pubkey: account(m) }));
export const accounts = (state) => [...new Set(roster(state).map((m) => m.pubkey))];
const accountAt = (state, leaf) => {
  const m = mls.members(state).find((x) => x.index === leaf);
  return m ? account(m) : null;
};

// Every invariant a Marmot epoch must hold. Throws with the reason.
export function checkState(state) {
  const v = groupView(state);
  if (!v.required.includes(COMP.PROOF) || !v.required.includes(COMP.ADMINS)) throw new Error("group does not require proofs and an admin policy");
  for (const id of v.required)
    if (id !== COMP.APP_COMPONENTS && !SUPPORTED.includes(id)) throw new Error("group requires component " + hex4(id));
  if (comp(state.extensions, COMP.PROOF)) throw new Error("proof component in group state");
  const members = mls.members(state);
  for (const m of members) if (!leafOk(m.leaf)) throw new Error("member without a valid account proof");
  if (!v.admins.length) throw new Error("group has no admin");
  const have = new Set(members.map(account));
  for (const a of v.admins) if (!have.has(a)) throw new Error("admin without a member leaf");
  return v;
}

// Authorize a processed commit against its parent state, then hold the
// resulting epoch to the invariants. Returns the edge convergence orders by.
function checkCommit(parent, res, digest) {
  const committer = accountAt(parent, res.sender);
  if (!committer) throw new Error("commit from a non-member");
  const pv = groupView(parent);
  const props = res.proposals || [];
  const kinds = props.map((p) => p.proposal.type);
  for (const p of props)
    if (p.proposal.type === mls.PROPOSAL.SELF_REMOVE && pv.admins.includes(accountAt(parent, p.sender)))
      throw new Error("an admin cannot self-remove");
  // one operation per component per commit; "last one wins" is not defined
  const touched = props.filter((p) => p.proposal.type === mls.PROPOSAL.APP_DATA_UPDATE).map((p) => p.proposal.componentId);
  if (new Set(touched).size !== touched.length) throw new Error("two updates to one component");
  const selfUpdate = !props.length;
  const selfRemoveOnly = props.length > 0 && kinds.every((k) => k === mls.PROPOSAL.SELF_REMOVE);
  const privileged = !(selfUpdate || selfRemoveOnly);
  if (privileged && !pv.admins.includes(committer)) throw new Error("commit by a non-admin");
  if (!res.removedSelf) {
    checkState(res.state);
    // a leaf may rotate its keys, never its account
    if (accountAt(res.state, res.sender) !== committer) throw new Error("committer changed identity");
  }
  return { digest, committer, privileged };
}

// privileged before ordinary, then the lower committer, then the lower digest
const beats = (a, b) =>
  a.privileged !== b.privileged ? a.privileged
    : a.committer !== b.committer ? a.committer < b.committer
      : a.digest < b.digest;

// ---- nostr event shapes ----

const keyMemo = new WeakMap();
const groupKey = (state) => {
  let k = keyMemo.get(state);
  if (!k) keyMemo.set(state, (k = mls.exportSecret(state, "marmot", utf8("group-event"), 32)));
  return k;
};

// kind 445: one MLS message under the epoch's exporter key, signed by a
// throwaway key, addressed by the state's routing id.
function seal(state, bytes, expiration) {
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(groupKey(state), nonce).encrypt(bytes);
  const tags = [["h", groupView(state).routing.id]];
  if (expiration) tags.push(["expiration", String(expiration)]);
  return finalizeEvent({ kind: KIND.GROUP, created_at: now(), tags, content: base64.encode(concatBytes(nonce, ct)) }, generateSecretKey());
}

function open(state, payload) {
  try { return chacha20poly1305(groupKey(state), payload.subarray(0, 12)).decrypt(payload.subarray(12)); } catch { return null; }
}

// kind 444, unsigned: the Welcome for one invitee, to be gift-wrapped.
export function welcomeRumor(pubkey, welcome, keyPackageEventId, relays) {
  const r = { kind: KIND.WELCOME, pubkey, created_at: now(), content: base64.encode(welcome), tags: [["relays", ...relays], ["e", keyPackageEventId]] };
  r.id = getEventHash(r);
  return r;
}

export function readWelcome(rumor) {
  if (rumor.kind !== KIND.WELCOME || rumor.sig) throw new Error("not a welcome");
  const e = one(rumor, "e");
  const rel = rumor.tags.filter((t) => t[0] === "relays");
  if (!e || !/^[0-9a-f]{64}$/.test(e) || rel.length !== 1 || rel[0].length < 2) throw new Error("malformed welcome");
  const relays = rel[0].slice(1);
  if (!relays.every(relayOk) || new Set(relays).size !== relays.length) throw new Error("malformed welcome relays");
  return { bytes: base64.decode(rumor.content), keyPackageEventId: e, relays };
}

// The app payload inside MLS: a nostr event with an id and no signature.
export function appEvent(pubkey, kind, content, tags = [], created_at = now()) {
  const e = { pubkey, created_at, kind, tags, content };
  return { id: getEventHash(e), ...e };
}

const APP_KEYS = ["content", "created_at", "id", "kind", "pubkey", "tags"];
function readAppEvent(bytes, sender) {
  let e;
  try { e = JSON.parse(text(bytes)); } catch { return null; }
  if (!e || typeof e !== "object" || Object.keys(e).sort().join() !== APP_KEYS.join()) return null;
  if (typeof e.content !== "string" || !Number.isInteger(e.created_at) || !Number.isInteger(e.kind) || !Array.isArray(e.tags)) return null;
  if (!e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return null;
  // MLS authenticated the leaf; the event must name that leaf's account
  if (e.pubkey !== sender) return null;
  try { if (getEventHash(e) !== e.id) return null; } catch { return null; }
  return e;
}

// ---- the group engine ----
//
// A group record is plain data, persisted whole:
//   tip      the canonical MLS state
//   past     the epochs behind it (newest first, at most five): late app
//            messages decrypt there, and a competing commit forks from there
//   via      how the tip was reached { digest, committer, privileged }
//   pending  a commit of ours that is published but not yet acknowledged —
//            it becomes the tip only when a relay takes it
//   alt      a peer's commit that lost to `pending`; applied if ours fails
//   held     kind-445 events no retained epoch could open yet
//   seen     ids already processed (outer event ids and MLS message ids)
//   log      delivered app events, oldest first
//   from     nothing older than this can concern us (when we joined)
//   heard    the newest relay timestamp processed: where to resume listening
//
// Convergence here is the spec's branch rule without the app-message witness
// boost: deeper branch first, then privileged, lower committer, lower digest.

const SEEN_MAX = 2000, HELD_MAX = 100, LOG_MAX = 400;

const record = (state, me, extra) => ({
  id: bytesToHex(state.groupId),
  me,
  tip: state,
  past: [],
  via: null,
  pending: null,
  alt: null,
  held: [],
  seen: [],
  log: [],
  routes: [],
  removed: false,
  leaving: false,
  at: now(),
  from: now(),
  heard: 0,
  ...extra,
});

// Where a subscription for this group should start. Ten minutes of slack
// covers relays that lag each other; a timestamp is only ever a fetch hint.
export const since = (g) => Math.max(0, (g.heard || g.from) - 600);

// ids are remembered by their first 16 hex characters: plenty against
// accidents, and the record is rewritten whole on every message
const short = (id) => id.slice(0, 16);
const sawIt = (g, id) => g.seen.includes(short(id));
function see(g, id) {
  g.seen.push(short(id));
  if (g.seen.length > SEEN_MAX) g.seen.splice(0, g.seen.length - SEEN_MAX);
}

// Every routing address this group still has to be heard on: the current
// one and those of the epochs we retain.
export function routes(g) {
  const out = new Map();
  for (const s of [g.tip, ...(g.pending ? [g.pending.state] : []), ...g.past]) {
    let r;
    try { r = groupView(s).routing; } catch { continue; }
    if (r && !out.has(r.id)) out.set(r.id, r.relays);
  }
  return [...out].map(([id, relays]) => ({ id, relays }));
}

export const isAdmin = (g) => groupView(g.tip).admins.includes(g.me);
// A direct chat: two accounts and no name. Everything else is a group.
export function directPeer(g) {
  const acc = accounts(g.tip);
  if (acc.length !== 2 || !acc.includes(g.me) || groupView(g.tip).name) return null;
  return acc.find((a) => a !== g.me);
}

// Found a group: epoch 0 with only us, then one founding commit that adds
// the invitees (nobody else exists yet, so nothing has to be published).
// Returns the record and the Welcome to deliver to each invitee.
export function found(device, { name = "", about = "", relays, invitees = [], adminKeys = [] }) {
  const reqComps = [COMP.ADMINS, COMP.ROUTING, COMP.PROOF, COMP.LIFECYCLE, COMP.MEDIA_V2, ...(name || about ? [COMP.PROFILE] : [])];
  const entries = [
    { id: COMP.APP_COMPONENTS, data: idList.enc(reqComps) },
    { id: COMP.ADMINS, data: admins.enc([device.pubkey, ...adminKeys]) },
    { id: COMP.ROUTING, data: routing.enc({ id: bytesToHex(randomBytes(32)), relays }) },
    { id: COMP.LIFECYCLE, data: Uint8Array.of(0) },
    { id: COMP.MEDIA_V2, data: mediaPolicy.enc(MEDIA_ENDPOINTS) },
    ...(name || about ? [{ id: COMP.PROFILE, data: profile.enc({ name, about }) }] : []),
  ];
  const required = {
    type: mls.EXT.REQUIRED_CAPABILITIES,
    data: concatBytes(vec(u16(mls.EXT.APP_DATA_DICTIONARY)), vec(u16(mls.PROPOSAL.APP_DATA_UPDATE)), vec()),
  };
  const state0 = mls.createGroup({
    groupId: randomBytes(16),
    sig: device.sig,
    identity: hexToBytes(device.pubkey),
    capabilities: capabilities(),
    leafExtensions: leafExtensions(device.proof),
    extensions: [required, dictExt(entries)],
    lifetime: lifetime(),
  });
  const g = record(state0, device.pubkey);
  if (!invitees.length) { checkState(state0); return { g, welcome: null }; }
  for (const c of invitees) if (!fits(state0, c)) throw new Error("invitee cannot join this group");
  const r = mls.createCommit(state0, { proposals: invitees.map((c) => mls.proposeAdd(c.keyPackage)) });
  checkState(r.state);
  g.tip = r.state;
  g.past = [state0];
  g.via = { digest: bytesToHex(sha256(r.message)), committer: device.pubkey, privileged: true };
  return { g, welcome: r.welcome };
}

// Join from a Welcome addressed to us. `kps` are this device's KeyPackage
// records; nothing is consumed unless every check passes.
export function join(device, rumor, kps) {
  const w = readWelcome(rumor);
  let state = null, used = null, err = null;
  const first = kps.filter((k) => k.eventId === w.keyPackageEventId);
  for (const k of [...first, ...kps.filter((x) => !first.includes(x))]) {
    try {
      state = mls.joinWelcome(w.bytes, { keyPackage: k.keyPackage, secrets: k.secrets, sig: device.sig });
      used = k;
      break;
    } catch (e) { err = e; }
  }
  if (!state) throw err || new Error("welcome is not for this device");
  const v = checkState(state);
  if (!v.routing) throw new Error("group has no nostr routing");
  if (v.disbanded) throw new Error("group was disbanded");
  // the only authority a first-time joiner can check: the inviter is an
  // admin of the state it handed us, and it is who the gift wrap said
  const inviter = accountAt(state, state.joinedVia);
  if (!inviter || !v.admins.includes(inviter)) throw new Error("invited by a non-admin");
  if (inviter !== rumor.pubkey) throw new Error("welcome author mismatch");
  // the group may have moved on while the Welcome sat in the inbox: listen from when it was written
  return { g: record(state, device.pubkey, { inviter, fresh: true, from: Math.min(now(), rumor.created_at) - 3600 }), used };
}

function advance(g, state, edge) {
  g.past.unshift(g.tip);
  g.past.length = Math.min(g.past.length, MAX_REWIND);
  g.tip = state;
  g.via = edge;
}

// Membership and settings changes between two epochs, as kind-1210-shaped
// rows for the transcript (synthesized locally from signed state).
function changes(before, after, actor, at) {
  const out = [];
  const row = (type, data) => {
    out.push(appEvent(actor, KIND.SYSTEM, JSON.stringify({ v: 1, system_type: type, text: type.replace(/_/g, " "), data: { actor, ...data } }), [["system", type]], at));
  };
  const a = accounts(before), b = accounts(after);
  for (const pk of b) if (!a.includes(pk)) row("member_added", { subject: pk });
  for (const pk of a) if (!b.includes(pk)) row(pk === actor ? "member_left" : "member_removed", { subject: pk });
  const va = groupView(before), vb = groupView(after);
  if (vb.disbanded && !va.disbanded) return [appEvent(actor, KIND.SYSTEM, JSON.stringify({ v: 1, system_type: "group_disbanded", text: "Group disbanded", data: { actor } }), [["system", "group_disbanded"]], at)];
  for (const pk of vb.admins) if (!va.admins.includes(pk) && a.includes(pk)) row("admin_added", { subject: pk });
  for (const pk of va.admins) if (!vb.admins.includes(pk) && b.includes(pk)) row("admin_removed", { subject: pk });
  if (va.name !== vb.name) row("group_renamed", { name: vb.name });
  return out;
}

function deliver(g, out, ev, epoch, state) {
  if (g.log.some((m) => m.id === ev.id)) return;
  ev = { ...ev, epoch };
  // an attachment is keyed to the epoch its message came in: keep that
  // epoch's media secret for as long as the message is in the log
  if (state && ev.tags.some(isMediaTag)) {
    g.media ||= {};
    g.media[epoch] ||= bytesToHex(mediaSecret(state));
  }
  g.log.push(ev);
  if (g.log.length > LOG_MAX) {
    g.log.splice(0, g.log.length - LOG_MAX);
    if (g.media) {
      const live = new Set(g.log.map((m) => String(m.epoch)));
      for (const e of Object.keys(g.media)) if (!live.has(e)) delete g.media[e];
    }
  }
  out.push(ev);
}

function applyCommit(g, out, parent, res, edge, at) {
  const sys = res.removedSelf ? [] : changes(parent, res.state, edge.committer, at);
  if (res.removedSelf) {
    g.removed = true;
    out.push({ removed: true });
    return;
  }
  advance(g, res.state, edge);
  if (groupView(g.tip).disbanded) g.removed = true;
  for (const ev of sys) deliver(g, out, ev, g.tip.epoch);
  out.push({ epoch: g.tip.epoch });
}

// One kind-445 event in. Returns what the app needs to hear about:
// delivered app events, { epoch } on a state change, { removed }, { withdrawn: [ids] },
// { selfRemove: leaf } when a peer asks to leave. Mutates the record.
export function receive(g, ev) {
  const out = [];
  if (g.removed) return out;
  if (sawIt(g, ev.id)) return out;
  if (g.pending && g.pending.ev.id === ev.id) { confirm(g, out); return out; }
  let mark = progress(g);
  if (take(g, ev, out)) g.heard = Math.max(g.heard || 0, Math.min(ev.created_at, now()));
  // new state (an epoch, a cached proposal) is what makes held input usable: go round again
  while (g.held.length && !g.removed && progress(g) !== mark) {
    mark = progress(g);
    for (const h of g.held.splice(0)) take(g, h, out);
  }
  return out;
}

// changes whenever input that was unusable may have become usable
const progress = (g) => g.tip.epoch + ":" + (g.via ? g.via.digest : "") + ":" + (g.tip.pending || []).length + ":" + (g.pending ? 1 : 0);

function hold(g, ev) {
  if (g.held.some((h) => h.id === ev.id)) return;
  g.held.push(ev);
  if (g.held.length > HELD_MAX) g.held.shift();
}
const unsee = (g, ...ids) => { ids = ids.map(short); g.seen = g.seen.filter((x) => !ids.includes(x)); };

// One event through the engine: processed, rejected for good, or held for later.
function take(g, ev, out) {
  let payload;
  try { payload = base64.decode(ev.content); } catch { see(g, ev.id); return true; }
  if (payload.length < 28) { see(g, ev.id); return true; }
  let src = null, bytes = null;
  for (const s of [g.tip, ...(g.pending ? [g.pending.state] : []), ...g.past]) {
    bytes = open(s, payload);
    if (bytes) { src = s; break; }
  }
  if (!bytes) { hold(g, ev); return false; }
  see(g, ev.id);
  const digest = bytesToHex(sha256(bytes));
  if (sawIt(g, digest)) return true;
  see(g, digest);
  let peek;
  try { peek = mls.decodeMessage(bytes); } catch { return true; }

  // somebody built on our unacknowledged commit: it reached the relays after all
  if (g.pending && src === g.pending.state) { confirm(g, out); src = g.tip; }

  try {
    if (peek.contentType === "application") {
      if (g.tip.epoch - src.epoch > PAST_EPOCHS) return true;
      const r = mls.processMessage(src, bytes);
      swap(g, src, r.state);
      const inner = readAppEvent(r.data, accountAt(src, r.sender));
      if (inner) deliver(g, out, inner, src.epoch, src);
    } else if (peek.contentType === "proposal") {
      if (src !== g.tip) return true; // proposals are epoch-bound: stale
      const r = mls.processMessage(src, bytes);
      g.tip = r.state;
      if (r.proposal.type === mls.PROPOSAL.SELF_REMOVE) out.push({ selfRemove: r.sender, who: accountAt(src, r.sender) });
    } else if (peek.contentType === "commit") {
      const r = mls.processMessage(src, bytes);
      const edge = checkCommit(src, r, digest);
      if (src === g.tip) {
        if (g.pending) {
          // a race from the same parent: ours is not canonical yet. Order them now;
          // every member that sees both makes the same call.
          if (beats(g.pending.edge, edge)) { g.alt = { ev, digest }; unsee(g, ev.id, digest); return true; }
          g.pending = null;
          out.push({ lost: true });
        }
        applyCommit(g, out, src, r, edge, ev.created_at);
      } else if (src === g.past[0] && g.via && beats(edge, g.via)) {
        // a sibling of the commit we applied wins the tie-break: switch branch
        const dropped = g.log.filter((m) => m.epoch === g.tip.epoch).map((m) => m.id);
        g.log = g.log.filter((m) => m.epoch !== g.tip.epoch);
        g.tip = g.past.shift();
        applyCommit(g, out, src, r, edge, ev.created_at);
        if (dropped.length) out.push({ withdrawn: dropped });
      }
      // anything else forks from further back than a one-commit branch can win
    }
  } catch (e) {
    // a commit can overtake the proposal it references (relays do not order):
    // keep it until the proposal shows up
    if (e && (e.code === "missing-proposal") && src === g.tip) {
      unsee(g, ev.id, digest);
      hold(g, ev);
      return false;
    }
    out.push({ invalid: String(e && e.message || e) });
  }
  return true;
}

function swap(g, old, next) {
  if (g.tip === old) g.tip = next;
  else {
    const i = g.past.indexOf(old);
    if (i >= 0) g.past[i] = next;
  }
}

// ---- our own output ----

// An app event out. The ratchet has moved once this returns: persist the
// record before the event leaves.
export function send(g, inner) {
  const at = g.tip;
  const r = mls.encryptApplication(g.tip, utf8(JSON.stringify(inner)));
  const v = groupView(g.tip);
  const ev = seal(g.tip, r.message, v.retention ? inner.created_at + v.retention : 0);
  g.tip = r.state;
  see(g, ev.id);
  see(g, bytesToHex(sha256(r.message)));
  const out = [];
  deliver(g, out, inner, at.epoch, at);
  return ev;
}

// Stage a commit. It is NOT group state until a relay acknowledges the
// returned event: call confirm() then, or drop() if nobody would take it.
export function stage(g, { proposals = [] } = {}) {
  if (g.pending) throw new Error("a change is already on its way");
  const r = mls.createCommit(g.tip, { proposals });
  const digest = bytesToHex(sha256(r.message));
  const edge = checkCommit(g.tip, { ...r, sender: g.tip.leafIndex, proposals: staged(g.tip, proposals), removedSelf: false }, digest);
  g.pending = { state: r.state, ev: seal(g.tip, r.message), edge, welcome: r.welcome, at: now() };
  return g.pending;
}

// what createCommit will have committed: the inline proposals plus the pending by-reference ones
const staged = (state, inline) => [
  ...inline.map((proposal) => ({ proposal, sender: state.leafIndex, byRef: false })),
  ...(state.pending || []).map((p) => ({ proposal: p.proposal, sender: p.sender, byRef: true })),
];

export function confirm(g, out = []) {
  const p = g.pending;
  if (!p) return out;
  g.pending = null;
  g.alt = null;
  const parent = g.tip;
  see(g, p.ev.id);
  see(g, p.edge.digest);
  applyCommit(g, out, parent, { state: p.state, removedSelf: false }, p.edge, p.ev.created_at);
  return out;
}

// Our commit never made it out. If a peer's commit was waiting behind it, that one goes in.
export function drop(g) {
  const out = [];
  const alt = g.alt;
  g.pending = null;
  g.alt = null;
  if (alt) return receive(g, alt.ev);
  return out;
}

// The proposals for common changes.
export const invite = (cands) => cands.map((c) => mls.proposeAdd(c.keyPackage));
export function remove(g, pubkey) {
  const leaves = roster(g.tip).filter((m) => m.pubkey === pubkey).map((m) => mls.proposeRemove(m.leaf));
  const v = groupView(g.tip);
  // an admin's last leaf and its admin entry leave in the same commit
  return v.admins.includes(pubkey) ? [...leaves, setAdmins(v.admins.filter((a) => a !== pubkey))] : leaves;
}
export const setAdmins = (list) => mls.proposeAppDataUpdate(COMP.ADMINS, admins.enc(list));
export const setProfile = (name, about = "") => mls.proposeAppDataUpdate(COMP.PROFILE, profile.enc({ name, about }));

// Leaving is a proposal somebody else commits. The record goes quiet at once.
export function leave(g) {
  const r = mls.createProposal(g.tip, mls.proposeSelfRemove());
  const ev = seal(g.tip, r.message);
  g.tip = r.state;
  g.leaving = true;
  see(g, ev.id);
  see(g, bytesToHex(sha256(r.message)));
  return ev;
}

// ---- encrypted media (encrypted-media-v2) ----
// An attachment is a blob on a Blossom server, encrypted under a key that
// only members can derive: the group's media secret at the epoch the
// carrying message is sent in, stretched by the file's own hash, type and
// name. The message carries an imeta tag that points at the blob.

const MEDIA_V2 = "encrypted-media-v2";
// where members of the groups we found upload: hosts that take an anonymous
// encrypted blob and serve it with CORS
export const MEDIA_ENDPOINTS = ["https://blossom.ditto.pub/", "https://nostr.download/"];

const mediaPolicy = {
  enc: (endpoints) => concatBytes(
    vec(utf8(MEDIA_V2)),
    vec(vec(utf8("blossom-v1"))),
    vec(...endpoints.map((u) => concatBytes(vec(utf8("blossom-v1")), vec(utf8(u)))))),
};

export const mediaSecret = (state) => mls.exportSecret(state, "marmot", utf8("encrypted-media"), 32);

// the shared Marmot media-type algorithm (canonical-encoding.md)
const TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
export function mediaType(value) {
  let m = String(value || "").split(";")[0].replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  const parts = m.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 64 || parts[1].length > 64 || m.length > 128 ||
      !TOKEN.test(parts[0]) || !TOKEN.test(parts[1])) return null;
  return m === "image/jpg" ? "image/jpeg" : m;
}
const nameOk = (n) => typeof n === "string" && !n.includes("\0") && utf8(n).length >= 1 && utf8(n).length <= 255;

const nul = Uint8Array.of(0);
const mediaAad = (hash, m, name) => concatBytes(utf8(MEDIA_V2), nul, hash, nul, utf8(m), nul, utf8(name));
const fileKey = (secret, hash, m, name) => expand(sha256, secret, concatBytes(mediaAad(hash, m, name), nul, utf8("key")), 32);

// Encrypt one file for this epoch. Returns the blob to upload and the
// reference the imeta tag is made from once the blob has a URL.
export function sealMedia(secret, plain, { type, name }) {
  const m = mediaType(type) || "application/octet-stream";
  name = String(name || "file").replace(/\0/g, "");
  while (utf8(name).length > 255) name = name.slice(0, -1);
  if (!nameOk(name)) name = "file";
  const hash = sha256(plain);
  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(fileKey(secret, hash, m, name), nonce, mediaAad(hash, m, name)).encrypt(plain);
  return { cipher, ref: { plain: bytesToHex(hash), cipher: bytesToHex(sha256(cipher)), nonce: bytesToHex(nonce), m, name } };
}

export function mediaTag(ref, urls, dim) {
  return ["imeta", "v " + MEDIA_V2, ...urls.map((u) => "locator blossom-v1 " + u),
    "ciphertext_sha256 " + ref.cipher, "plaintext_sha256 " + ref.plain, "nonce " + ref.nonce,
    "m " + ref.m, "filename " + ref.name, ...(dim ? ["dim " + dim] : [])];
}

const isMediaTag = (t) => t[0] === "imeta" && t.includes("v " + MEDIA_V2);
const HEX32 = /^[0-9a-f]{64}$/;

// A v2 imeta tag, validated; null when it is not one or is malformed
// (which drops that attachment only, never the message).
export function readMediaTag(tag) {
  if (!Array.isArray(tag) || tag[0] !== "imeta") return null;
  const one = {}, urls = [];
  for (const f of tag.slice(1)) {
    const i = f.indexOf(" ");
    if (i < 1) return null;
    const k = f.slice(0, i), v = f.slice(i + 1);
    if (k === "locator") {
      const j = v.indexOf(" ");
      const kind = v.slice(0, j), url = v.slice(j + 1);
      if (j < 1 || !url) return null;
      if (kind === "blossom-v1") {
        try { if (!/^https?:$/.test(new URL(url).protocol)) return null; } catch { return null; }
        urls.push(url);
      }
      continue;
    }
    if (k in one) return null; // every other field appears once
    one[k] = v;
  }
  if (one.v !== MEDIA_V2 || "blurhash" in one || !HEX32.test(one.ciphertext_sha256 || "") || !HEX32.test(one.plaintext_sha256 || "") ||
      !/^[0-9a-f]{24}$/.test(one.nonce || "") || !one.m || mediaType(one.m) !== one.m || !nameOk(one.filename)) return null;
  return { urls, ref: { plain: one.plaintext_sha256, cipher: one.ciphertext_sha256, nonce: one.nonce, m: one.m, name: one.filename }, dim: one.dim || "" };
}

// Decrypt a fetched blob. Throws when the blob is not the one referenced.
export function openMedia(secret, cipher, ref) {
  if (bytesToHex(sha256(cipher)) !== ref.cipher) throw new Error("blob hash mismatch");
  const hash = hexToBytes(ref.plain);
  const plain = chacha20poly1305(fileKey(secret, hash, ref.m, ref.name), hexToBytes(ref.nonce), mediaAad(hash, ref.m, ref.name)).decrypt(cipher);
  if (bytesToHex(sha256(plain)) !== ref.plain) throw new Error("plaintext hash mismatch");
  return plain;
}

// The media secret for an epoch this group record has kept, or null.
export const mediaSecretAt = (g, epoch) => (g.media && g.media[epoch] ? hexToBytes(g.media[epoch]) : null);
