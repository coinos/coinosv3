// MLS (RFC 9420) — the group key agreement under Marmot / White Noise
// https://www.rfc-editor.org/rfc/rfc9420.html
//
// One ciphersuite (0x0001: X25519 / AES-128-GCM / SHA-256 / Ed25519), basic
// credentials, and the draft-ietf-mls-extensions-10 pieces Marmot needs:
// app_data_dictionary, app_data_update, app_ephemeral, self_remove. Protocol-pure
// and synchronous: no DOM, no app state, no storage.
//
// States are plain data (objects, arrays, numbers, strings, Uint8Array) and are
// never mutated: every call returns a new state, so the caller can keep old
// epochs and candidate branches around. Where ts-mls and OpenMLS disagree the
// code follows OpenMLS, because that is what the other clients run.
//
// Decoded but refused: reinit, external_init / external commits, external and
// new_member senders, reinit and branch PSKs. We never send Update proposals
// (a commit rotates our leaf) but apply other members'.

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { extract, expand } from "@noble/hashes/hkdf";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes.js";

export const EXT = {
  APPLICATION_ID: 1,
  RATCHET_TREE: 2,
  REQUIRED_CAPABILITIES: 3,
  EXTERNAL_PUB: 4,
  EXTERNAL_SENDERS: 5,
  APP_DATA_DICTIONARY: 6,
};

export const PROPOSAL = {
  ADD: 1,
  UPDATE: 2,
  REMOVE: 3,
  PSK: 4,
  REINIT: 5,
  EXTERNAL_INIT: 6,
  GROUP_CONTEXT_EXTENSIONS: 7,
  APP_DATA_UPDATE: 8,
  APP_EPHEMERAL: 9,
  SELF_REMOVE: 10,
};

export const LEAF_SOURCE = { KEY_PACKAGE: 1, UPDATE: 2, COMMIT: 3 };

const WIRE = { PUBLIC: 1, PRIVATE: 2, WELCOME: 3, GROUP_INFO: 4, KEY_PACKAGE: 5 };
const WIRE_NAME = [undefined, "public", "private", "welcome", "group_info", "key_package"];
const CONTENT = { APPLICATION: 1, PROPOSAL: 2, COMMIT: 3 };
const CONTENT_NAME = [undefined, "application", "proposal", "commit"];
const SENDER = { MEMBER: 1, EXTERNAL: 2, NEW_MEMBER_PROPOSAL: 3, NEW_MEMBER_COMMIT: 4 };

const EMPTY = new Uint8Array(0);
const ZERO32 = new Uint8Array(32);
// how far a sender's ratchet may jump ahead, and how many skipped keys we keep per ratchet
const MAX_SKIP = 1000;

const utf8 = (s) => new TextEncoder().encode(s);
const hex = bytesToHex;

const fail = (msg, code) => {
  let e = new Error("mls: " + msg);
  if (code) e.code = code;
  throw e;
};

const concat = (...arrs) => {
  let out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (let a of arrs) (out.set(a, o), (o += a.length));
  return out;
};

const eq = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

// ---- TLS presentation language, with RFC 9420 §2.1.2 variable-length vectors ----

export class Writer {
  constructor() {
    this.parts = [];
  }
  bytes(b) {
    this.parts.push(b);
    return this;
  }
  uint(n, size) {
    if (!Number.isInteger(n) || n < 0 || n >= 2 ** (8 * size))
      fail(`uint${8 * size} out of range: ${n}`);
    let b = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--) ((b[i] = n % 256), (n = Math.floor(n / 256)));
    return this.bytes(b);
  }
  u8(n) {
    return this.uint(n, 1);
  }
  u16(n) {
    return this.uint(n, 2);
  }
  u32(n) {
    return this.uint(n, 4);
  }
  // numbers past 2^53 travel as decimal strings (see Reader.u64)
  u64(n) {
    let v = BigInt(n);
    if (v < 0n || v >> 64n) fail("uint64 out of range: " + n);
    return this.u32(Number(v >> 32n)).u32(Number(v & 0xffffffffn));
  }
  varint(n) {
    if (n < 64) return this.u8(n);
    if (n < 16384) return this.u16(n | 0x4000);
    if (n < 0x40000000) return this.u32(n + 0x80000000);
    return fail("vector too long");
  }
  vec(b) {
    return this.varint(b.length).bytes(b);
  }
  list(items, fn) {
    let w = new Writer();
    items.forEach((item, i) => fn(w, item, i));
    return this.vec(w.finish());
  }
  opt(v, fn) {
    if (v == null) return this.u8(0);
    fn(this.u8(1), v);
    return this;
  }
  finish() {
    return concat(...this.parts);
  }
}

export class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.end) fail("truncated input");
    let p = this.pos;
    this.pos += n;
    return p;
  }
  u8() {
    return this.buf[this.need(1)];
  }
  u16() {
    let p = this.need(2);
    return (this.buf[p] << 8) | this.buf[p + 1];
  }
  u32() {
    let p = this.need(4);
    return (
      this.buf[p] * 0x1000000 + ((this.buf[p + 1] << 16) | (this.buf[p + 2] << 8) | this.buf[p + 3])
    );
  }
  // a JS number while it is exact, a decimal string beyond that — never a BigInt,
  // so decoded structures stay structured-clone friendly and still re-encode exactly
  u64() {
    let hi = this.u32();
    let lo = this.u32();
    return hi < 0x200000 ? hi * 0x100000000 + lo : ((BigInt(hi) << 32n) | BigInt(lo)).toString();
  }
  // copies: a view would pin (and structured-clone) the whole message buffer
  bytes(n) {
    let p = this.need(n);
    return this.buf.slice(p, p + n);
  }
  varint() {
    let b = this.u8();
    let prefix = b >> 6;
    if (prefix === 3) fail("invalid vector length");
    let n = b & 0x3f;
    for (let i = (1 << prefix) - 1; i > 0; i--) n = n * 256 + this.u8();
    if ((prefix === 1 && n < 64) || (prefix === 2 && n < 16384))
      fail("vector length not in shortest form");
    return n;
  }
  vec() {
    return this.bytes(this.varint());
  }
  list(fn) {
    let n = this.varint();
    let sub = new Reader(this.buf, this.need(n), this.pos);
    let out = [];
    while (sub.pos < sub.end) out.push(fn(sub, out.length));
    return out;
  }
  opt(fn) {
    let b = this.u8();
    if (b > 1) fail("invalid optional");
    return b ? fn(this) : null;
  }
  done() {
    if (this.pos !== this.end) fail("trailing bytes");
  }
}

const enc = (fn, v, ...rest) => fn(new Writer(), v, ...rest).finish();
const dec = (fn, bytes) => {
  let r = new Reader(bytes);
  let v = fn(r);
  r.done();
  return v;
};

// ---- ciphersuite 0x0001 ----

const mac = (key, data) => hmac(sha256, key, data);

const expandWithLabel = (secret, label, context, length) =>
  expand(
    sha256,
    secret,
    new Writer()
      .u16(length)
      .vec(utf8("MLS 1.0 " + label))
      .vec(context)
      .finish(),
    length,
  );
const deriveSecret = (secret, label) => expandWithLabel(secret, label, EMPTY, 32);
const deriveTreeSecret = (secret, label, generation, length) =>
  expandWithLabel(secret, label, new Writer().u32(generation).finish(), length);
const refHash = (label, value) => sha256(new Writer().vec(utf8(label)).vec(value).finish());

const labeled = (label, content) =>
  new Writer()
    .vec(utf8("MLS 1.0 " + label))
    .vec(content)
    .finish();
// Ed25519 private keys are the 32-byte seed; some libraries hand out seed || public
const signWithLabel = (priv, label, content) =>
  ed25519.sign(labeled(label, content), priv.subarray(0, 32));
const verifyWithLabel = (pub, label, content, signature) => {
  try {
    return ed25519.verify(signature, labeled(label, content), pub);
  } catch {
    return false;
  }
};

// HPKE (RFC 9180), base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM
const KEM_SUITE = concat(utf8("KEM"), Uint8Array.of(0, 0x20));
const HPKE_SUITE = concat(utf8("HPKE"), Uint8Array.of(0, 0x20, 0, 1, 0, 1));
const HPKE_V1 = utf8("HPKE-v1");

const labeledExtract = (suite, salt, label, ikm) =>
  extract(sha256, concat(HPKE_V1, suite, utf8(label), ikm), salt);
const labeledExpand = (suite, prk, label, info, length) =>
  expand(
    sha256,
    prk,
    concat(Uint8Array.of(length >> 8, length & 255), HPKE_V1, suite, utf8(label), info),
    length,
  );

const deriveKeyPair = (ikm) => {
  let priv = labeledExpand(
    KEM_SUITE,
    labeledExtract(KEM_SUITE, EMPTY, "dkp_prk", ikm),
    "sk",
    EMPTY,
    32,
  );
  return { priv, pub: x25519.getPublicKey(priv) };
};

const hpkeKey = (dh, kemOutput, pub, info) => {
  let eae = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh);
  let shared = labeledExpand(KEM_SUITE, eae, "shared_secret", concat(kemOutput, pub), 32);
  let context = concat(
    Uint8Array.of(0),
    labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY),
    labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info),
  );
  let secret = labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, 16),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
};

const hpkeSeal = (pub, info, aad, plaintext) => {
  let eph = randomBytes(32);
  let kemOutput = x25519.getPublicKey(eph);
  let { key, nonce } = hpkeKey(x25519.getSharedSecret(eph, pub), kemOutput, pub, info);
  return { kemOutput, ciphertext: gcm(key, nonce, aad).encrypt(plaintext) };
};

const hpkeOpen = (priv, kemOutput, info, aad, ciphertext) => {
  let { key, nonce } = hpkeKey(
    x25519.getSharedSecret(priv, kemOutput),
    kemOutput,
    x25519.getPublicKey(priv),
    info,
  );
  return gcm(key, nonce, aad).decrypt(ciphertext);
};

const encryptWithLabel = (pub, label, context, plaintext) =>
  hpkeSeal(pub, labeled(label, context), EMPTY, plaintext);
const decryptWithLabel = (priv, label, context, kemOutput, ciphertext) =>
  hpkeOpen(priv, kemOutput, labeled(label, context), EMPTY, ciphertext);

// ---- structures ----

const wU16s = (w, list) => w.list(list, (w, n) => w.u16(n));
const rU16s = (r) => r.list((r) => r.u16());

// extensions stay { type, data }: unknown and GREASE types round-trip untouched
const wExts = (w, exts) => w.list(exts, (w, e) => w.u16(e.type).vec(e.data));
const rExts = (r) => r.list((r) => ({ type: r.u16(), data: r.vec() }));

const CAPS = ["versions", "ciphersuites", "extensions", "proposals", "credentials"];
const wCaps = (w, c) => CAPS.reduce((w, k) => wU16s(w, c[k]), w);
const rCaps = (r) => Object.fromEntries(CAPS.map((k) => [k, rU16s(r)]));

const wLeafBody = (w, l) => {
  w.vec(l.encryptionKey).vec(l.signatureKey).u16(l.credential.type).vec(l.credential.identity);
  wCaps(w, l.capabilities).u8(l.source);
  if (l.source === LEAF_SOURCE.KEY_PACKAGE) w.u64(l.lifetime.notBefore).u64(l.lifetime.notAfter);
  if (l.source === LEAF_SOURCE.COMMIT) w.vec(l.parentHash);
  return wExts(w, l.extensions);
};
const wLeaf = (w, l) => wLeafBody(w, l).vec(l.signature);
const rLeaf = (r) => {
  // every credential is type + one vector on the wire (basic: identity, x509: the chain),
  // so unknown kinds decode as opaque; only basic is accepted as a member
  let l = {
    encryptionKey: r.vec(),
    signatureKey: r.vec(),
    credential: { type: r.u16(), identity: r.vec() },
  };
  l.capabilities = rCaps(r);
  l.source = r.u8();
  if (l.source === LEAF_SOURCE.KEY_PACKAGE) l.lifetime = { notBefore: r.u64(), notAfter: r.u64() };
  else if (l.source === LEAF_SOURCE.COMMIT) l.parentHash = r.vec();
  else if (l.source !== LEAF_SOURCE.UPDATE) fail("unknown leaf node source " + l.source);
  l.extensions = rExts(r);
  l.signature = r.vec();
  return l;
};
const leafTBS = (l, groupId, leafIndex) => {
  let w = wLeafBody(new Writer(), l);
  if (l.source !== LEAF_SOURCE.KEY_PACKAGE) w.vec(groupId).u32(leafIndex);
  return w.finish();
};
const signLeaf = (l, priv, groupId, leafIndex) => ({
  ...l,
  signature: signWithLabel(priv, "LeafNodeTBS", leafTBS(l, groupId, leafIndex)),
});

const wKeyPackageBody = (w, k) =>
  wExts(wLeaf(w.u16(k.version).u16(k.cipherSuite).vec(k.initKey), k.leaf), k.extensions);
const wKeyPackage = (w, k) => wKeyPackageBody(w, k).vec(k.signature);
const rKeyPackage = (r) => ({
  version: r.u16(),
  cipherSuite: r.u16(),
  initKey: r.vec(),
  leaf: rLeaf(r),
  extensions: rExts(r),
  signature: r.vec(),
});
const keyPackageRef = (k) => refHash("MLS 1.0 KeyPackage Reference", enc(wKeyPackage, k));

const wParent = (w, p) =>
  w
    .vec(p.encryptionKey)
    .vec(p.parentHash)
    .list(p.unmergedLeaves, (w, n) => w.u32(n));
const rParent = (r) => ({
  encryptionKey: r.vec(),
  parentHash: r.vec(),
  unmergedLeaves: r.list((r) => r.u32()),
});

// a ratchet tree is an array over node indices: leaves at even slots, parents at
// odd ones, null for blank; always 2^k - 1 wide
const wTree = (w, tree) => {
  let n = tree.length;
  while (n && !tree[n - 1]) n--;
  return w.list(tree.slice(0, n), (w, node, i) =>
    w.opt(node, (w, node) => (i % 2 ? wParent(w.u8(2), node) : wLeaf(w.u8(1), node))),
  );
};
const rTree = (r) => {
  let tree = r.list((r, i) =>
    r.opt((r) => {
      if (r.u8() !== (i % 2 ? 2 : 1)) fail("ratchet tree: wrong node type at index " + i);
      return i % 2 ? rParent(r) : rLeaf(r);
    }),
  );
  if (!tree.length || !tree[tree.length - 1]) fail("ratchet tree must end in a non-blank node");
  let width = 1;
  while (width < tree.length) width = 2 * width + 1;
  while (tree.length < width) tree.push(null);
  return tree;
};

const wContext = (w, c) =>
  wExts(
    w
      .u16(c.version)
      .u16(c.cipherSuite)
      .vec(c.groupId)
      .u64(c.epoch)
      .vec(c.treeHash)
      .vec(c.confirmedTranscriptHash),
    c.extensions,
  );
const rContext = (r) => ({
  version: r.u16(),
  cipherSuite: r.u16(),
  groupId: r.vec(),
  epoch: r.u64(),
  treeHash: r.vec(),
  confirmedTranscriptHash: r.vec(),
  extensions: rExts(r),
});

const wPskId = (w, p) => {
  w.u8(p.psktype);
  if (p.psktype === 1) w.vec(p.pskId);
  else w.u8(p.usage).vec(p.pskGroupId).u64(p.pskEpoch);
  return w.vec(p.nonce);
};
const rPskId = (r) => {
  let p = { psktype: r.u8() };
  if (p.psktype === 1) p.pskId = r.vec();
  else if (p.psktype === 2)
    Object.assign(p, { usage: r.u8(), pskGroupId: r.vec(), pskEpoch: r.u64() });
  else fail("unknown PSK type " + p.psktype);
  p.nonce = r.vec();
  return p;
};

const wProposal = (w, p) => {
  w.u16(p.type);
  switch (p.type) {
    case PROPOSAL.ADD:
      return wKeyPackage(w, p.keyPackage);
    case PROPOSAL.UPDATE:
      return wLeaf(w, p.leaf);
    case PROPOSAL.REMOVE:
      return w.u32(p.removed);
    case PROPOSAL.PSK:
      return wPskId(w, p.psk);
    case PROPOSAL.REINIT:
      return wExts(w.vec(p.groupId).u16(p.version).u16(p.cipherSuite), p.extensions);
    case PROPOSAL.EXTERNAL_INIT:
      return w.vec(p.kemOutput);
    case PROPOSAL.GROUP_CONTEXT_EXTENSIONS:
      return wExts(w, p.extensions);
    case PROPOSAL.APP_DATA_UPDATE:
      w.u16(p.componentId).u8(p.op);
      return p.op === 1 ? w.vec(p.data) : w;
    case PROPOSAL.APP_EPHEMERAL:
      return w.u16(p.componentId).vec(p.data);
    case PROPOSAL.SELF_REMOVE:
      return w;
    default:
      return w.vec(p.data);
  }
};
const rProposal = (r) => {
  let type = r.u16();
  switch (type) {
    case PROPOSAL.ADD:
      return { type, keyPackage: rKeyPackage(r) };
    case PROPOSAL.UPDATE:
      return { type, leaf: rLeaf(r) };
    case PROPOSAL.REMOVE:
      return { type, removed: r.u32() };
    case PROPOSAL.PSK:
      return { type, psk: rPskId(r) };
    case PROPOSAL.REINIT:
      return {
        type,
        groupId: r.vec(),
        version: r.u16(),
        cipherSuite: r.u16(),
        extensions: rExts(r),
      };
    case PROPOSAL.EXTERNAL_INIT:
      return { type, kemOutput: r.vec() };
    case PROPOSAL.GROUP_CONTEXT_EXTENSIONS:
      return { type, extensions: rExts(r) };
    case PROPOSAL.APP_DATA_UPDATE: {
      let p = { type, componentId: r.u16(), op: r.u8() };
      if (p.op === 1) p.data = r.vec();
      else if (p.op !== 2) fail("unknown app_data_update operation " + p.op);
      return p;
    }
    case PROPOSAL.APP_EPHEMERAL:
      return { type, componentId: r.u16(), data: r.vec() };
    case PROPOSAL.SELF_REMOVE:
      return { type };
    default:
      // unknown and GREASE proposal types carry one opaque vector (as OpenMLS frames them)
      return { type, data: r.vec() };
  }
};

const wHpke = (w, c) => w.vec(c.kemOutput).vec(c.ciphertext);
const rHpke = (r) => ({ kemOutput: r.vec(), ciphertext: r.vec() });

const wPath = (w, p) =>
  wLeaf(w, p.leaf).list(p.nodes, (w, n) => w.vec(n.encryptionKey).list(n.secrets, wHpke));
const rPath = (r) => ({
  leaf: rLeaf(r),
  nodes: r.list((r) => ({ encryptionKey: r.vec(), secrets: r.list(rHpke) })),
});

const wCommit = (w, c) =>
  w
    .list(c.proposals, (w, p) => (p.ref ? w.u8(2).vec(p.ref) : wProposal(w.u8(1), p.proposal)))
    .opt(c.path, wPath);
const rCommit = (r) => ({
  proposals: r.list((r) => {
    let t = r.u8();
    if (t === 1) return { proposal: rProposal(r) };
    if (t === 2) return { ref: r.vec() };
    return fail("unknown ProposalOrRef type " + t);
  }),
  path: r.opt(rPath),
});

const wSender = (w, s) => {
  w.u8(s.type);
  if (s.type === SENDER.MEMBER) w.u32(s.leafIndex);
  if (s.type === SENDER.EXTERNAL) w.u32(s.senderIndex);
  return w;
};
const rSender = (r) => {
  let type = r.u8();
  if (type === SENDER.MEMBER) return { type, leafIndex: r.u32() };
  if (type === SENDER.EXTERNAL) return { type, senderIndex: r.u32() };
  if (type === SENDER.NEW_MEMBER_PROPOSAL || type === SENDER.NEW_MEMBER_COMMIT) return { type };
  return fail("unknown sender type " + type);
};

const wBody = (w, c) =>
  c.contentType === CONTENT.APPLICATION
    ? w.vec(c.data)
    : c.contentType === CONTENT.PROPOSAL
      ? wProposal(w, c.proposal)
      : wCommit(w, c.commit);
const rBody = (r, contentType) => {
  if (contentType === CONTENT.APPLICATION) return { data: r.vec() };
  if (contentType === CONTENT.PROPOSAL) return { proposal: rProposal(r) };
  if (contentType === CONTENT.COMMIT) return { commit: rCommit(r) };
  return fail("unknown content type " + contentType);
};

// FramedContent
const wContent = (w, c) =>
  wBody(wSender(w.vec(c.groupId).u64(c.epoch), c.sender).vec(c.aad).u8(c.contentType), c);
const rContent = (r) => {
  let c = {
    groupId: r.vec(),
    epoch: r.u64(),
    sender: rSender(r),
    aad: r.vec(),
    contentType: r.u8(),
  };
  return Object.assign(c, rBody(r, c.contentType));
};

const wAuth = (w, a, contentType) =>
  contentType === CONTENT.COMMIT ? w.vec(a.signature).vec(a.confirmationTag) : w.vec(a.signature);
const rAuth = (r, contentType) =>
  contentType === CONTENT.COMMIT
    ? { signature: r.vec(), confirmationTag: r.vec() }
    : { signature: r.vec() };

const wPublic = (w, m) => {
  wAuth(wContent(w, m.content), m.auth, m.content.contentType);
  return m.content.sender.type === SENDER.MEMBER ? w.vec(m.membershipTag) : w;
};
const rPublic = (r) => {
  let content = rContent(r);
  let m = { content, auth: rAuth(r, content.contentType) };
  if (content.sender.type === SENDER.MEMBER) m.membershipTag = r.vec();
  return m;
};

const wPrivate = (w, m) =>
  w
    .vec(m.groupId)
    .u64(m.epoch)
    .u8(m.contentType)
    .vec(m.aad)
    .vec(m.encryptedSenderData)
    .vec(m.ciphertext);
const rPrivate = (r) => ({
  groupId: r.vec(),
  epoch: r.u64(),
  contentType: r.u8(),
  aad: r.vec(),
  encryptedSenderData: r.vec(),
  ciphertext: r.vec(),
});

const wGroupInfoTBS = (w, g) =>
  wExts(wContext(w, g.context), g.extensions).vec(g.confirmationTag).u32(g.signer);
const wGroupInfo = (w, g) => wGroupInfoTBS(w, g).vec(g.signature);
const rGroupInfo = (r) => ({
  context: rContext(r),
  extensions: rExts(r),
  confirmationTag: r.vec(),
  signer: r.u32(),
  signature: r.vec(),
});

const wWelcome = (w, m) =>
  w
    .u16(m.cipherSuite)
    .list(m.secrets, (w, s) => wHpke(w.vec(s.ref), s))
    .vec(m.encryptedGroupInfo);
const rWelcome = (r) => ({
  cipherSuite: r.u16(),
  secrets: r.list((r) => ({ ref: r.vec(), ...rHpke(r) })),
  encryptedGroupInfo: r.vec(),
});

const wGroupSecrets = (w, g) =>
  w
    .vec(g.joinerSecret)
    .opt(g.pathSecret, (w, s) => w.vec(s))
    .list(g.psks, wPskId);
const rGroupSecrets = (r) => ({
  joinerSecret: r.vec(),
  pathSecret: r.opt((r) => r.vec()),
  psks: r.list(rPskId),
});

const BODY = [undefined, "public", "private", "welcome", "groupInfo", "keyPackage"];
const W_BODY = [undefined, wPublic, wPrivate, wWelcome, wGroupInfo, wKeyPackage];
const R_BODY = [undefined, rPublic, rPrivate, rWelcome, rGroupInfo, rKeyPackage];

const wMessage = (w, m) => W_BODY[m.wireFormat](w.u16(1).u16(m.wireFormat), m[BODY[m.wireFormat]]);
const rMessage = (r) => {
  let version = r.u16();
  let wireFormat = r.u16();
  if (version !== 1) fail("unsupported protocol version " + version, "unsupported");
  if (!R_BODY[wireFormat]) fail("unknown wire format " + wireFormat);
  return { wireFormat, [BODY[wireFormat]]: R_BODY[wireFormat](r) };
};

// ---- extensions we read ----

const extOf = (exts, type) => exts.find((e) => e.type === type)?.data;

const uniqueTypes = (exts, what) => {
  if (new Set(exts.map((e) => e.type)).size !== exts.length)
    fail("duplicate extension type in " + what);
};

const requiredCapabilities = (exts) => {
  let data = extOf(exts, EXT.REQUIRED_CAPABILITIES);
  return data
    ? dec((r) => ({ extensions: rU16s(r), proposals: rU16s(r), credentials: rU16s(r) }), data)
    : null;
};

// the RFC 9420 types every client supports without listing them in its capabilities
const supportsExtension = (caps, t) => (t >= 1 && t <= 5) || caps.extensions.includes(t);
const supportsProposal = (caps, t) => (t >= 1 && t <= 7) || caps.proposals.includes(t);
const meetsRequired = (caps, rc) =>
  !rc ||
  (rc.extensions.every((t) => supportsExtension(caps, t)) &&
    rc.proposals.every((t) => supportsProposal(caps, t)) &&
    rc.credentials.every((t) => caps.credentials.includes(t)));

// app_data_dictionary: entries are { id, data }, sorted by id, one per component
export const encodeDict = (entries) => {
  let sorted = [...entries].sort((a, b) => a.id - b.id);
  if (sorted.some((e, i) => i && sorted[i - 1].id === e.id))
    fail("app_data_dictionary: duplicate component id");
  return new Writer().list(sorted, (w, e) => w.u16(e.id).vec(e.data)).finish();
};

export const decodeDict = (bytes) => {
  let entries = dec((r) => r.list((r) => ({ id: r.u16(), data: r.vec() })), bytes);
  if (entries.some((e, i) => i && entries[i - 1].id >= e.id))
    fail("app_data_dictionary: entries not sorted and unique");
  return entries;
};

export const dictOf = (extensions) => {
  let data = extOf(extensions, EXT.APP_DATA_DICTIONARY);
  return data ? decodeDict(data) : [];
};

// ---- tree math (RFC 9420 appendix C, complete trees only) ----

const level = (x) => {
  let k = 0;
  while ((x >> k) & 1) k++;
  return k;
};
const left = (x) => x ^ (1 << (level(x) - 1));
const right = (x) => x ^ (3 << (level(x) - 1));
const parent = (x) => {
  let k = level(x);
  return (x | (1 << k)) & ~(1 << (k + 1));
};
const rootOf = (width) => width >> 1;
const sibling = (x) => {
  let p = parent(x);
  return x < p ? right(p) : left(p);
};
const directPath = (x, width) => {
  let path = [];
  while (x !== rootOf(width)) path.push((x = parent(x)));
  return path;
};
const inSubtree = (top, x) => Math.abs(x - top) < 1 << level(top);

const resolution = (tree, x) => {
  let node = tree[x];
  if (node) return x % 2 ? [x, ...node.unmergedLeaves.map((l) => 2 * l)] : [x];
  return x % 2 ? [...resolution(tree, left(x)), ...resolution(tree, right(x))] : [];
};

// the direct path of leaf node x minus the parents whose copath child resolves to nobody
const filteredPath = (tree, x) => {
  let out = [];
  while (x !== rootOf(tree.length)) {
    let copath = sibling(x);
    let res = resolution(tree, copath);
    x = parent(x);
    if (res.length) out.push({ node: x, copath, res });
  }
  return out;
};

// `without` (a Set of leaf indices) hashes the subtree as it was before those leaves joined
const treeHash = (tree, x, without) => {
  if (x % 2 === 0) {
    let leaf = without?.has(x / 2) ? null : tree[x];
    return sha256(
      new Writer()
        .u8(1)
        .u32(x / 2)
        .opt(leaf, wLeaf)
        .finish(),
    );
  }
  let node = tree[x];
  if (node && without)
    node = { ...node, unmergedLeaves: node.unmergedLeaves.filter((l) => !without.has(l)) };
  return sha256(
    new Writer()
      .u8(2)
      .opt(node, wParent)
      .vec(treeHash(tree, left(x), without))
      .vec(treeHash(tree, right(x), without))
      .finish(),
  );
};
const rootHash = (tree) => treeHash(tree, rootOf(tree.length));

// the hash a child stores to pin parent node p, given the copath child s under p
const parentHashOf = (tree, p, s) => {
  let node = tree[p];
  let without = node.unmergedLeaves.length ? new Set(node.unmergedLeaves) : undefined;
  return sha256(
    new Writer()
      .vec(node.encryptionKey)
      .vec(node.parentHash)
      .vec(treeHash(tree, s, without))
      .finish(),
  );
};

// RFC 9420 §7.9.2: every non-blank parent must be vouched for by a node in the
// resolution of one of its children (one that was there when the parent was set)
const verifyParentHashes = (tree) =>
  tree.every((node, x) => {
    if (!node || x % 2 === 0) return true;
    let late = new Set(node.unmergedLeaves);
    return [
      [left(x), right(x)],
      [right(x), left(x)],
    ].some(([child, other]) => {
      let ph = parentHashOf(tree, x, other);
      return resolution(tree, child).some((d) => {
        if (d % 2 === 0 && late.has(d / 2)) return false;
        let stored = d % 2 || tree[d].source === LEAF_SOURCE.COMMIT ? tree[d].parentHash : null;
        return stored && eq(stored, ph);
      });
    });
  });

// tree edits work on a fresh copy of the array and replace nodes, never touch them

const blankPath = (tree, x) => {
  for (let p of directPath(x, tree.length)) tree[p] = null;
};

const truncate = (tree) => {
  let n = tree.length;
  while (n > 1 && !tree[n - 1]) n--;
  let width = 1;
  while (width < n) width = 2 * width + 1;
  tree.length = width;
};

const addLeaf = (tree, leaf) => {
  let x = 0;
  while (x < tree.length && tree[x]) x += 2;
  if (x >= tree.length) for (let n = tree.length + 1; n > 0; n--) tree.push(null);
  tree[x] = leaf;
  // sorted, as OpenMLS keeps (and requires) them; ts-mls appends
  for (let p of directPath(x, tree.length))
    if (tree[p])
      tree[p] = {
        ...tree[p],
        unmergedLeaves: [...tree[p].unmergedLeaves, x / 2].sort((a, b) => a - b),
      };
  return x / 2;
};

// ---- validation ----

// RFC 9420 §7.3, the parts that need only the leaf and the group's extensions
const checkLeaf = (leaf, groupId, leafIndex, extensions, now) => {
  if (leaf.encryptionKey.length !== 32 || leaf.signatureKey.length !== 32)
    fail("leaf node key of the wrong size");
  if (
    !verifyWithLabel(
      leaf.signatureKey,
      "LeafNodeTBS",
      leafTBS(leaf, groupId, leafIndex),
      leaf.signature,
    )
  )
    fail("invalid leaf node signature");
  if (leaf.credential.type !== 1)
    fail("unsupported credential type " + leaf.credential.type, "unsupported");
  let caps = leaf.capabilities;
  if (!caps.versions.includes(1) || !caps.ciphersuites.includes(1))
    fail("leaf node does not support this protocol version and ciphersuite");
  if (!caps.credentials.includes(leaf.credential.type))
    fail("leaf node credential type missing from its capabilities");
  uniqueTypes(leaf.extensions, "leaf node");
  if (!leaf.extensions.every((e) => supportsExtension(caps, e.type)))
    fail("leaf node extension missing from its capabilities");
  if (!meetsRequired(caps, requiredCapabilities(extensions)))
    fail("leaf node lacks the group's required capabilities");
  if (leaf.source === LEAF_SOURCE.KEY_PACKAGE) {
    let from = BigInt(leaf.lifetime.notBefore);
    let to = BigInt(leaf.lifetime.notAfter);
    if (from > to) fail("leaf node lifetime ends before it starts");
    if (now != null && (from > BigInt(now) || to <= BigInt(now)))
      fail("key package outside its lifetime", "lifetime");
  }
};

const checkKeyPackage = (kp) => {
  if (kp.version !== 1 || kp.cipherSuite !== 1)
    fail("key package for another version or ciphersuite", "unsupported");
  if (kp.leaf.source !== LEAF_SOURCE.KEY_PACKAGE)
    fail("key package leaf node has the wrong source");
  if (kp.initKey.length !== 32 || eq(kp.initKey, kp.leaf.encryptionKey))
    fail("key package init key invalid");
  uniqueTypes(kp.extensions, "key package");
  if (
    !verifyWithLabel(kp.leaf.signatureKey, "KeyPackageTBS", enc(wKeyPackageBody, kp), kp.signature)
  )
    fail("invalid key package signature");
};

const checkTreeKeys = (tree) => {
  let seen = new Set();
  tree.forEach((node, x) => {
    if (!node) return;
    let keys = x % 2 ? [node.encryptionKey] : [node.encryptionKey, node.signatureKey];
    for (let k of keys.map(hex)) {
      if (seen.has(k)) fail("key appears twice in the ratchet tree");
      seen.add(k);
    }
  });
};

const checkAllSupport = (tree, extensions) => {
  let rc = requiredCapabilities(extensions);
  tree.forEach((leaf, x) => {
    if (!leaf || x % 2) return;
    if (
      !meetsRequired(leaf.capabilities, rc) ||
      !extensions.every((e) => supportsExtension(leaf.capabilities, e.type))
    )
      fail("a member does not support the group context extensions");
  });
};

// a tree somebody handed us (Welcome): RFC 9420 §12.4.3.1
const checkTree = (tree, groupId, extensions, now) => {
  tree.forEach((node, x) => {
    if (!node) return;
    if (x % 2 === 0) return checkLeaf(node, groupId, x / 2, extensions, now);
    let last = -1;
    for (let l of node.unmergedLeaves) {
      if (l <= last) fail("unmerged leaves not sorted");
      last = l;
      if (2 * l >= tree.length || !tree[2 * l] || !inSubtree(x, 2 * l))
        fail("unmerged leaf is not a member below its node");
      for (let p of directPath(2 * l, tree.length)) {
        if (p === x) break;
        if (tree[p] && !tree[p].unmergedLeaves.includes(l))
          fail("unmerged leaf missing from an intermediate node");
      }
    }
  });
  checkTreeKeys(tree);
  if (!verifyParentHashes(tree)) fail("invalid parent hash in ratchet tree");
};

// ---- key schedule ----

const epochKeys = (epochSecret) => {
  let d = (label) => deriveSecret(epochSecret, label);
  return {
    encryption: d("encryption"),
    keys: {
      senderData: d("sender data"),
      exporter: d("exporter"),
      external: d("external"),
      confirmation: d("confirm"),
      membership: d("membership"),
      resumption: d("resumption"),
      authenticator: d("authentication"),
      init: d("init"),
    },
  };
};

const joinerSecret = (init, commitSecret, context) =>
  expandWithLabel(extract(sha256, commitSecret, init), "joiner", context, 32);

const fromJoiner = (joiner, pskSecret, context) => {
  let member = extract(sha256, pskSecret, joiner);
  return {
    welcome: deriveSecret(member, "welcome"),
    ...epochKeys(expandWithLabel(member, "epoch", context, 32)),
  };
};

const welcomeCipher = (welcome) =>
  gcm(expandWithLabel(welcome, "key", EMPTY, 16), expandWithLabel(welcome, "nonce", EMPTY, 12));

// RFC 9420 §8.4; `psks` is [{ id, psk }]
const pskSecret = (psks) =>
  psks.reduce((secret, { id, psk }, i) => {
    let label = wPskId(new Writer(), id).u16(i).u16(psks.length).finish();
    let input = expandWithLabel(extract(sha256, psk, ZERO32), "derived psk", label, 32);
    return extract(sha256, secret, input);
  }, ZERO32);

// PSKs come from the caller: { [hex(psk_id)]: bytes } for external ones, and
// { ["resumption:" + epoch]: state.keys.resumption } for earlier epochs of this
// group (we only hold the current epoch's ourselves)
const lookupPsks = (ids, known = {}, s) => {
  if (new Set(ids.map((id) => hex(enc(wPskId, id)))).size !== ids.length) fail("duplicate PSK id");
  return pskSecret(
    ids.map((id) => {
      let psk = id.psktype === 1 ? known[hex(id.pskId)] : null;
      if (id.psktype === 2) {
        if (id.usage !== 1 || !s || !eq(id.pskGroupId, s.groupId))
          fail("reinit and branch PSKs are not supported", "unsupported");
        psk = id.pskEpoch === s.epoch ? s.keys.resumption : known["resumption:" + id.pskEpoch];
      }
      if (!psk)
        fail(
          id.psktype === 1 ? "unknown external PSK" : "no resumption PSK for epoch " + id.pskEpoch,
          "unsupported",
        );
      return { id, psk };
    }),
  );
};

const interimHash = (confirmed, tag) => sha256(concat(confirmed, new Writer().vec(tag).finish()));
const confirmedHash = (interim, wire, content, signature) =>
  sha256(concat(interim, wContent(new Writer().u16(wire), content).vec(signature).finish()));

// ---- secret tree (RFC 9420 §9) ----
//
// { nodes: { nodeIndex: secret }, ratchets: { leafNodeIndex: { h, a } } }: node
// secrets are expanded only on the way down to a leaf that speaks, and deleted
// once used. A ratchet is { gen, secret, skip: { generation: { key, nonce } } }.

const ratchetKey = (r) => ({
  key: deriveTreeSecret(r.secret, "key", r.gen, 16),
  nonce: deriveTreeSecret(r.secret, "nonce", r.gen, 12),
});
const ratchetNext = (r) => ({
  ...r,
  gen: r.gen + 1,
  secret: deriveTreeSecret(r.secret, "secret", r.gen, 32),
});

const leafRatchets = (st, width, x) => {
  if (st.ratchets[x]) return st;
  let nodes = { ...st.nodes };
  let path = [x, ...directPath(x, width)].reverse();
  let i = path.findIndex((n) => nodes[n]);
  if (i < 0) fail("secret tree has no secret for leaf " + x / 2);
  for (; path[i] !== x; i++) {
    let n = path[i];
    nodes[left(n)] = expandWithLabel(nodes[n], "tree", utf8("left"), 32);
    nodes[right(n)] = expandWithLabel(nodes[n], "tree", utf8("right"), 32);
    delete nodes[n];
  }
  let ratchet = (label) => ({
    gen: 0,
    secret: expandWithLabel(nodes[x], label, EMPTY, 32),
    skip: {},
  });
  let ratchets = { ...st.ratchets, [x]: { h: ratchet("handshake"), a: ratchet("application") } };
  delete nodes[x];
  return { nodes, ratchets };
};

const setRatchet = (st, x, kind, r) => ({
  ...st,
  ratchets: { ...st.ratchets, [x]: { ...st.ratchets[x], [kind]: r } },
});

// the key for `generation`, and the ratchet after it has been taken
const seek = (r, generation) => {
  if (generation < r.gen) {
    let kn = r.skip[generation];
    if (!kn) fail("message key already used", "replay");
    let skip = { ...r.skip };
    delete skip[generation];
    return { kn, r: { ...r, skip } };
  }
  if (generation - r.gen > MAX_SKIP) fail("message generation too far ahead");
  let skip = { ...r.skip };
  for (; r.gen < generation; r = ratchetNext(r)) skip[r.gen] = ratchetKey(r);
  let gens = Object.keys(skip);
  for (let g of gens.slice(0, Math.max(0, gens.length - MAX_SKIP))) delete skip[g];
  return { kn: ratchetKey(r), r: { ...ratchetNext(r), skip } };
};

// ---- message framing ----

const contentTBS = (s, wire, content) => {
  let w = wContent(new Writer().u16(1).u16(wire), content);
  let t = content.sender.type;
  if (t === SENDER.MEMBER || t === SENDER.NEW_MEMBER_COMMIT) wContext(w, s);
  return w.finish();
};

const signContent = (s, wire, content) =>
  signWithLabel(s.sigPriv, "FramedContentTBS", contentTBS(s, wire, content));

const memberLeaf = (s, leafIndex) => {
  let leaf = 2 * leafIndex < s.tree.length ? s.tree[2 * leafIndex] : null;
  return leaf || fail("sender is not a member of the group");
};

const verifyContent = (s, wire, content, auth) => {
  let leaf = memberLeaf(s, content.sender.leafIndex);
  if (
    !verifyWithLabel(
      leaf.signatureKey,
      "FramedContentTBS",
      contentTBS(s, wire, content),
      auth.signature,
    )
  )
    fail("invalid message signature");
};

const membershipTag = (s, content, auth) =>
  mac(
    s.keys.membership,
    wAuth(
      new Writer().bytes(contentTBS(s, WIRE.PUBLIC, content)),
      auth,
      content.contentType,
    ).finish(),
  );

const sealPublic = (s, content, auth) =>
  enc(wMessage, {
    wireFormat: WIRE.PUBLIC,
    public: { content, auth, membershipTag: membershipTag(s, content, auth) },
  });

const refuseSender = (sender) => {
  if (sender.type === SENDER.EXTERNAL) fail("external senders are not supported", "unsupported");
  if (sender.type === SENDER.NEW_MEMBER_PROPOSAL)
    fail("new_member proposals are not supported", "unsupported");
  if (sender.type === SENDER.NEW_MEMBER_COMMIT)
    fail("external commits are not supported", "unsupported");
};

const openPublic = (s, m) => {
  refuseSender(m.content.sender);
  if (m.content.contentType === CONTENT.APPLICATION) fail("application data must be encrypted");
  if (!eq(m.membershipTag, membershipTag(s, m.content, m.auth))) fail("invalid membership tag");
  verifyContent(s, WIRE.PUBLIC, m.content, m.auth);
  return m;
};

const privateAAD = (m) =>
  new Writer().vec(m.groupId).u64(m.epoch).u8(m.contentType).vec(m.aad).finish();
const senderDataCipher = (s, m) => {
  let sample = m.ciphertext.subarray(0, 32);
  let aad = new Writer().vec(m.groupId).u64(m.epoch).u8(m.contentType).finish();
  let secret = s.keys.senderData;
  return gcm(
    expandWithLabel(secret, "key", sample, 16),
    expandWithLabel(secret, "nonce", sample, 12),
    aad,
  );
};
const guarded = (nonce, guard) => nonce.map((b, i) => (i < 4 ? b ^ guard[i] : b));
const ratchetKind = (contentType) => (contentType === CONTENT.APPLICATION ? "a" : "h");

const sealPrivate = (s, content, auth, padding = 0) => {
  let x = 2 * s.leafIndex;
  let kind = ratchetKind(content.contentType);
  let st = leafRatchets(s.secretTree, s.tree.length, x);
  let r = st.ratchets[x][kind];
  let kn = ratchetKey(r);
  let guard = randomBytes(4);
  let m = {
    groupId: content.groupId,
    epoch: content.epoch,
    contentType: content.contentType,
    aad: content.aad,
  };
  let body = wAuth(wBody(new Writer(), content), auth, content.contentType)
    .bytes(new Uint8Array(padding))
    .finish();
  m.ciphertext = gcm(kn.key, guarded(kn.nonce, guard), privateAAD(m)).encrypt(body);
  let senderData = new Writer().u32(s.leafIndex).u32(r.gen).bytes(guard).finish();
  m.encryptedSenderData = senderDataCipher(s, m).encrypt(senderData);
  return {
    message: enc(wMessage, { wireFormat: WIRE.PRIVATE, private: m }),
    secretTree: setRatchet(st, x, kind, ratchetNext(r)),
  };
};

// the ratchet only moves in the returned secretTree, and only once the message has authenticated
const openPrivate = (s, m) => {
  let sd;
  try {
    sd = new Reader(senderDataCipher(s, m).decrypt(m.encryptedSenderData));
  } catch {
    fail("cannot decrypt sender data");
  }
  let leafIndex = sd.u32();
  let generation = sd.u32();
  let guard = sd.bytes(4);
  sd.done();
  memberLeaf(s, leafIndex);
  if (leafIndex === s.leafIndex) fail("message was sent by this client", "own");
  let x = 2 * leafIndex;
  let kind = ratchetKind(m.contentType);
  let st = leafRatchets(s.secretTree, s.tree.length, x);
  let { kn, r } = seek(st.ratchets[x][kind], generation);
  let body;
  try {
    body = new Reader(gcm(kn.key, guarded(kn.nonce, guard), privateAAD(m)).decrypt(m.ciphertext));
  } catch {
    fail("cannot decrypt message");
  }
  let content = {
    groupId: m.groupId,
    epoch: m.epoch,
    sender: { type: SENDER.MEMBER, leafIndex },
    aad: m.aad,
    contentType: m.contentType,
    ...rBody(body, m.contentType),
  };
  let auth = rAuth(body, m.contentType);
  if (body.buf.subarray(body.pos).some((b) => b)) fail("non-zero message padding");
  verifyContent(s, WIRE.PRIVATE, content, auth);
  return { content, auth, secretTree: setRatchet(st, x, kind, r) };
};

// ---- key packages ----

const DEFAULT_CAPS = {
  versions: [1],
  ciphersuites: [1],
  extensions: [],
  proposals: [],
  credentials: [1],
};

const bytesOf = (v) => (typeof v === "string" ? utf8(v) : v);

// an hour of slack behind us and twelve weeks ahead: the widest range OpenMLS accepts
const lifetimeOf = (l = {}) => {
  let now = Math.floor(Date.now() / 1000);
  return { notBefore: l.notBefore ?? now - 3600, notAfter: l.notAfter ?? now + 84 * 86400 };
};

const newLeaf = ({ sig, identity, capabilities, leafExtensions = [], lifetime }, encryptionKey) =>
  signLeaf(
    {
      encryptionKey,
      signatureKey: sig.pub,
      credential: { type: 1, identity: bytesOf(identity) },
      capabilities: { ...DEFAULT_CAPS, ...capabilities },
      source: LEAF_SOURCE.KEY_PACKAGE,
      lifetime: lifetimeOf(lifetime),
      extensions: leafExtensions,
    },
    sig.priv,
  );

// { priv, pub }: an Ed25519 seed and its public key
export const generateSignatureKeyPair = () => {
  let priv = randomBytes(32);
  return { priv, pub: ed25519.getPublicKey(priv) };
};

// ({ sig, identity, capabilities, leafExtensions, extensions, lifetime }) →
// { keyPackage, message, ref, secrets: { initPriv, encPriv } }. `keyPackage` is the bare
// struct, `message` the same thing framed as an MLSMessage; keep `secrets` until the Welcome.
export const generateKeyPackage = (opts) => {
  let initPriv = randomBytes(32);
  let encPriv = randomBytes(32);
  let kp = {
    version: 1,
    cipherSuite: 1,
    initKey: x25519.getPublicKey(initPriv),
    leaf: newLeaf(opts, x25519.getPublicKey(encPriv)),
    extensions: opts.extensions || [],
  };
  kp.signature = signWithLabel(opts.sig.priv, "KeyPackageTBS", enc(wKeyPackageBody, kp));
  checkLeaf(kp.leaf, EMPTY, 0, []);
  checkKeyPackage(kp);
  return {
    keyPackage: enc(wKeyPackage, kp),
    message: enc(wMessage, { wireFormat: WIRE.KEY_PACKAGE, keyPackage: kp }),
    ref: keyPackageRef(kp),
    secrets: { initPriv, encPriv },
  };
};

// bare KeyPackage or MLSMessage(mls_key_package): a bare one starts version 1, suite 1
// where the framed one says version 1, wire format 5
const readKeyPackage = (bytes) =>
  bytes[2] === 0 && bytes[3] === WIRE.KEY_PACKAGE
    ? dec(rMessage, bytes).keyPackage || fail("not a key package")
    : dec(rKeyPackage, bytes);

// either framing; throws unless both signatures verify
export const parseKeyPackage = (bytes) => {
  let kp = readKeyPackage(bytes);
  checkKeyPackage(kp);
  if (!verifyWithLabel(kp.leaf.signatureKey, "LeafNodeTBS", leafTBS(kp.leaf), kp.leaf.signature))
    fail("invalid leaf node signature");
  let { initKey, leaf, extensions, cipherSuite, version } = kp;
  return {
    keyPackage: enc(wKeyPackage, kp),
    ref: keyPackageRef(kp),
    initKey,
    leaf,
    extensions,
    cipherSuite,
    version,
  };
};

// a look at an MLSMessage without any group state: enough to route it
export const decodeMessage = (bytes) => {
  let m = dec(rMessage, bytes);
  let out = { wireFormat: WIRE_NAME[m.wireFormat] };
  if (m.public) {
    let { groupId, epoch, sender, aad, contentType } = m.public.content;
    Object.assign(out, { groupId, epoch, sender, aad, contentType: CONTENT_NAME[contentType] });
  } else if (m.private) {
    let { groupId, epoch, aad, contentType } = m.private;
    Object.assign(out, {
      groupId,
      epoch,
      aad,
      contentType: CONTENT_NAME[contentType] || fail("unknown content type"),
    });
  } else if (m.welcome) {
    Object.assign(out, {
      cipherSuite: m.welcome.cipherSuite,
      refs: m.welcome.secrets.map((s) => s.ref),
    });
  } else if (m.groupInfo) {
    let { groupId, epoch } = m.groupInfo.context;
    Object.assign(out, {
      groupId,
      epoch,
      extensions: m.groupInfo.extensions,
      signer: m.groupInfo.signer,
    });
  } else {
    Object.assign(out, {
      keyPackage: enc(wKeyPackage, m.keyPackage),
      ref: keyPackageRef(m.keyPackage),
    });
  }
  return out;
};

// ---- groups ----

const secretTreeFor = (tree, encryption) => ({
  nodes: { [rootOf(tree.length)]: encryption },
  ratchets: {},
});

// ({ groupId, sig, identity, capabilities, leafExtensions, extensions, lifetime }) → state
// at epoch 0 with one member; `extensions` are the GroupContext's
export const createGroup = (opts) => {
  let { groupId, sig, extensions = [] } = opts;
  let encPriv = randomBytes(32);
  let leaf = newLeaf(opts, x25519.getPublicKey(encPriv));
  uniqueTypes(extensions, "group context");
  checkLeaf(leaf, groupId, 0, extensions);
  checkAllSupport([leaf], extensions);
  let tree = [leaf];
  let { keys, encryption } = epochKeys(randomBytes(32));
  let confirmationTag = mac(keys.confirmation, EMPTY);
  return {
    version: 1,
    cipherSuite: 1,
    groupId,
    epoch: 0,
    treeHash: rootHash(tree),
    confirmedTranscriptHash: EMPTY,
    extensions,
    interimTranscriptHash: interimHash(EMPTY, confirmationTag),
    confirmationTag,
    tree,
    leafIndex: 0,
    sigPriv: sig.priv,
    priv: { 0: encPriv },
    keys,
    secretTree: secretTreeFor(tree, encryption),
    pending: [],
  };
};

// node keys from a path secret upward: fp[from] is the node the secret belongs to
const derivePath = (tree, fp, from, secret) => {
  let priv = {};
  for (let i = from; i < fp.length; i++) {
    let kp = deriveKeyPair(deriveSecret(secret, "node"));
    if (!eq(kp.pub, tree[fp[i].node].encryptionKey))
      fail("path secret does not match the node's public key");
    priv[fp[i].node] = kp.priv;
    secret = deriveSecret(secret, "path");
  }
  return { priv, commitSecret: secret };
};

// The state a Welcome invites us into. `keyPackage` and `secrets` are what
// generateKeyPackage returned; `state.joinedVia` is the leaf that signed the GroupInfo.
// `ratchetTree` supplies the tree out of band when the GroupInfo has none, `now`
// (unix seconds) turns on the key package lifetime check for every leaf.
export const joinWelcome = (bytes, { keyPackage, secrets, sig, ratchetTree, psks, now } = {}) => {
  let { welcome } = dec(rMessage, bytes);
  if (!welcome) fail("not a Welcome message");
  if (welcome.cipherSuite !== 1)
    fail("unsupported ciphersuite " + welcome.cipherSuite, "unsupported");
  let kp = readKeyPackage(keyPackage);
  let ref = keyPackageRef(kp);
  let mine = welcome.secrets.find((e) => eq(e.ref, ref));
  if (!mine) fail("Welcome is not addressed to this key package", "not-for-us");
  if (
    !eq(x25519.getPublicKey(secrets.encPriv), kp.leaf.encryptionKey) ||
    !eq(sig.pub, kp.leaf.signatureKey)
  )
    fail("private keys do not match the key package");

  let groupSecrets;
  try {
    let plain = decryptWithLabel(
      secrets.initPriv,
      "Welcome",
      welcome.encryptedGroupInfo,
      mine.kemOutput,
      mine.ciphertext,
    );
    groupSecrets = dec(rGroupSecrets, plain);
  } catch (e) {
    if (e.code) throw e;
    fail("cannot decrypt group secrets");
  }
  let member = extract(sha256, lookupPsks(groupSecrets.psks, psks), groupSecrets.joinerSecret);
  let info;
  try {
    info = dec(
      rGroupInfo,
      welcomeCipher(deriveSecret(member, "welcome")).decrypt(welcome.encryptedGroupInfo),
    );
  } catch {
    fail("cannot decrypt group info");
  }
  let ctx = info.context;
  if (ctx.version !== 1 || ctx.cipherSuite !== 1)
    fail("group uses another version or ciphersuite", "unsupported");
  if (typeof ctx.epoch !== "number") fail("epoch out of range");
  uniqueTypes(ctx.extensions, "group context");

  // without the tree nothing in the GroupInfo can be checked, so it has to travel with it
  let treeBytes = extOf(info.extensions, EXT.RATCHET_TREE) || ratchetTree;
  if (!treeBytes) fail("Welcome carries no ratchet_tree extension");
  let tree = dec(rTree, treeBytes);
  let signer = 2 * info.signer < tree.length ? tree[2 * info.signer] : null;
  if (!signer) fail("GroupInfo signer is not in the tree");
  if (
    !verifyWithLabel(signer.signatureKey, "GroupInfoTBS", enc(wGroupInfoTBS, info), info.signature)
  )
    fail("invalid GroupInfo signature");
  if (!eq(rootHash(tree), ctx.treeHash)) fail("ratchet tree does not match the group's tree hash");
  checkTree(tree, ctx.groupId, ctx.extensions, now);

  let own = enc(wLeaf, kp.leaf);
  let x = tree.findIndex((node, i) => node && i % 2 === 0 && eq(enc(wLeaf, node), own));
  if (x < 0) fail("our leaf is not in the ratchet tree");
  let priv = { [x]: secrets.encPriv };
  if (groupSecrets.pathSecret) {
    let fp = filteredPath(tree, 2 * info.signer);
    let from = fp.findIndex((f) => inSubtree(f.node, x));
    if (from < 0) fail("no common ancestor with the GroupInfo signer");
    Object.assign(priv, derivePath(tree, fp, from, groupSecrets.pathSecret).priv);
  }

  let { keys, encryption } = epochKeys(expandWithLabel(member, "epoch", enc(wContext, ctx), 32));
  if (!eq(info.confirmationTag, mac(keys.confirmation, ctx.confirmedTranscriptHash)))
    fail("invalid confirmation tag");
  return {
    ...ctx,
    interimTranscriptHash: interimHash(ctx.confirmedTranscriptHash, info.confirmationTag),
    confirmationTag: info.confirmationTag,
    tree,
    leafIndex: x / 2,
    sigPriv: sig.priv,
    priv,
    keys,
    secretTree: secretTreeFor(tree, encryption),
    pending: [],
    joinedVia: info.signer,
  };
};

// ---- proposals ----

export const proposeAdd = (keyPackageBytes) => ({
  type: PROPOSAL.ADD,
  keyPackage: readKeyPackage(keyPackageBytes),
});
export const proposeRemove = (leafIndex) => ({ type: PROPOSAL.REMOVE, removed: leafIndex });
export const proposeGroupContextExtensions = (extensions) => ({
  type: PROPOSAL.GROUP_CONTEXT_EXTENSIONS,
  extensions,
});
export const proposeAppDataUpdate = (componentId, data) =>
  data == null
    ? { type: PROPOSAL.APP_DATA_UPDATE, componentId, op: 2 }
    : { type: PROPOSAL.APP_DATA_UPDATE, componentId, op: 1, data };
export const proposeAppEphemeral = (componentId, data) => ({
  type: PROPOSAL.APP_EPHEMERAL,
  componentId,
  data,
});
export const proposeSelfRemove = () => ({ type: PROPOSAL.SELF_REMOVE });

// the default meaning of app_data_update: the payload replaces the component's data.
// A caller's hook (id, current | undefined, updates[]) → bytes may say otherwise,
// or return undefined to refuse the commit.
const lastWins = (id, current, updates) => updates[updates.length - 1];

// draft-ietf-mls-extensions §4.7. As OpenMLS does it: start from the dictionary of
// the CURRENT context and re-add the extension at the END of the list — the
// position is part of the GroupContext every member hashes.
const applyAppData = (current, target, updates, hook = lastWins, strict) => {
  let dict = dictOf(current);
  for (let id of new Set(updates.map((u) => u.componentId))) {
    let ups = updates.filter((u) => u.componentId === id);
    let at = dict.findIndex((e) => e.id === id);
    if (ups.some((u) => u.op === 2)) {
      if (ups.length > 1)
        fail("app_data_update: a remove cannot share a commit with other changes to the component");
      // The draft calls removing absent state invalid and we never send it, but OpenMLS
      // only notices when the commit also carries the dictionary in a
      // GroupContextExtensions; refusing more than it does would fork us off the group.
      if (at < 0 && strict) fail("app_data_update: component " + id + " has no state to remove");
      if (at >= 0) dict.splice(at, 1);
      continue;
    }
    let data = hook(
      id,
      at < 0 ? undefined : dict[at].data,
      ups.map((u) => u.data),
    );
    if (!(data instanceof Uint8Array)) fail("app_data_update rejected for component " + id);
    if (at < 0) dict.push({ id, data });
    else dict[at] = { id, data };
  }
  return [
    ...target.filter((e) => e.type !== EXT.APP_DATA_DICTIONARY),
    { type: EXT.APP_DATA_DICTIONARY, data: encodeDict(dict) },
  ];
};

const requiresAppDataUpdate = (extensions) =>
  !!requiredCapabilities(extensions)?.proposals.includes(PROPOSAL.APP_DATA_UPDATE);

const PATH_REQUIRED = [
  PROPOSAL.UPDATE,
  PROPOSAL.REMOVE,
  PROPOSAL.EXTERNAL_INIT,
  PROPOSAL.GROUP_CONTEXT_EXTENSIONS,
  PROPOSAL.SELF_REMOVE,
];

// RFC 9420 §12.2 for a member's commit: validates `list` ([{ proposal, sender, byRef }])
// and applies it to a copy of the tree
const applyProposals = (s, list, committer, { appData, psks, now, own } = {}) => {
  let of = (type) => list.filter((e) => e.proposal.type === type);
  let types = list.map((e) => e.proposal.type);
  for (let t of types) {
    if (t === PROPOSAL.REINIT) fail("reinit is not supported", "unsupported");
    if (t === PROPOSAL.EXTERNAL_INIT) fail("external_init is not valid in a member's commit");
    if (t < 1 || t > PROPOSAL.SELF_REMOVE) fail("unsupported proposal type " + t, "unsupported");
  }

  let removals = new Set(of(PROPOSAL.REMOVE).map((e) => e.proposal.removed));
  for (let t of new Set(types.filter((t) => t > PROPOSAL.GROUP_CONTEXT_EXTENSIONS)))
    s.tree.forEach((leaf, x) => {
      if (leaf && x % 2 === 0 && !removals.has(x / 2) && !supportsProposal(leaf.capabilities, t))
        fail("proposal type " + t + " is not supported by every member");
    });

  let touched = new Set();
  let touch = (leafIndex) => {
    if (2 * leafIndex >= s.tree.length || !s.tree[2 * leafIndex])
      fail("proposal targets a blank leaf");
    if (touched.has(leafIndex)) fail("several update/remove proposals for the same leaf");
    touched.add(leafIndex);
  };
  for (let e of of(PROPOSAL.UPDATE)) {
    if (!e.byRef || e.sender === committer)
      fail("a committer cannot commit its own update proposal");
    touch(e.sender);
  }
  for (let e of of(PROPOSAL.REMOVE)) {
    if (e.proposal.removed === committer) fail("a committer cannot remove itself");
    touch(e.proposal.removed);
  }
  for (let e of of(PROPOSAL.SELF_REMOVE)) {
    // the leaver is the proposal's sender, so inline (sender = committer) can never be right
    if (!e.byRef || e.sender === committer)
      fail("self_remove must be committed by reference by another member");
    touch(e.sender);
  }

  let gce = of(PROPOSAL.GROUP_CONTEXT_EXTENSIONS);
  if (gce.length > 1) fail("several group_context_extensions proposals");
  let extensions = gce.length ? gce[0].proposal.extensions : s.extensions;
  if (gce.length) {
    uniqueTypes(extensions, "group context");
    // an OpenMLS rule, not an RFC one: whatever the context carries must be required of every member
    let required = requiredCapabilities(extensions)?.extensions || [];
    if (!extensions.every((e) => supportsExtension({ extensions: required }, e.type)))
      fail("group context extension type missing from required_capabilities");
    // with app_data_update required, the dictionary only changes through app_data_update
    if (requiresAppDataUpdate(s.extensions) || requiresAppDataUpdate(extensions)) {
      let a = extOf(s.extensions, EXT.APP_DATA_DICTIONARY);
      let b = extOf(extensions, EXT.APP_DATA_DICTIONARY);
      if (!!a !== !!b || (a && !eq(a, b)))
        fail(
          "group_context_extensions cannot change app_data_dictionary while app_data_update is required",
        );
    }
  }
  let firstAppData = types.indexOf(PROPOSAL.APP_DATA_UPDATE);
  if (firstAppData >= 0 && types.lastIndexOf(PROPOSAL.GROUP_CONTEXT_EXTENSIONS) > firstAppData)
    fail("app_data_update must come after group_context_extensions");

  let tree = s.tree.slice();
  for (let e of of(PROPOSAL.UPDATE)) {
    let leaf = e.proposal.leaf;
    if (leaf.source !== LEAF_SOURCE.UPDATE) fail("update proposal leaf node has the wrong source");
    checkLeaf(leaf, s.groupId, e.sender, extensions);
    if (eq(leaf.encryptionKey, tree[2 * e.sender].encryptionKey))
      fail("update proposal keeps the old encryption key");
    blankPath(tree, 2 * e.sender);
    tree[2 * e.sender] = leaf;
  }
  let leaving = [
    ...of(PROPOSAL.REMOVE).map((e) => e.proposal.removed),
    ...of(PROPOSAL.SELF_REMOVE).map((e) => e.sender),
  ];
  for (let leafIndex of leaving) {
    blankPath(tree, 2 * leafIndex);
    tree[2 * leafIndex] = null;
  }
  truncate(tree);
  let added = of(PROPOSAL.ADD).map((e) => {
    let keyPackage = e.proposal.keyPackage;
    checkKeyPackage(keyPackage);
    checkLeaf(keyPackage.leaf, EMPTY, 0, extensions, now);
    if (!s.extensions.every((ext) => supportsExtension(keyPackage.leaf.capabilities, ext.type)))
      fail("added member does not support the group context extensions");
    return { leafIndex: addLeaf(tree, keyPackage.leaf), keyPackage };
  });
  if (gce.length) checkAllSupport(tree, extensions);

  let updates = of(PROPOSAL.APP_DATA_UPDATE).map((e) => e.proposal);
  let carried = gce.length > 0 && !!extOf(extensions, EXT.APP_DATA_DICTIONARY);
  if (updates.length)
    extensions = applyAppData(s.extensions, extensions, updates, appData, own || carried);

  return {
    tree,
    extensions,
    added,
    removedSelf: leaving.includes(s.leafIndex),
    pathRequired: !list.length || types.some((t) => PATH_REQUIRED.includes(t)),
    pskSecret: lookupPsks(
      of(PROPOSAL.PSK).map((e) => e.proposal.psk),
      psks,
      s,
    ),
    pskIds: of(PROPOSAL.PSK).map((e) => e.proposal.psk),
    ephemeral: of(PROPOSAL.APP_EPHEMERAL).map((e) => ({
      componentId: e.proposal.componentId,
      data: e.proposal.data,
      sender: e.sender,
    })),
  };
};

// ---- commits ----

// writes the new parent nodes of a commit into the tree; returns the parent hash the leaf must carry
const setPath = (tree, x, fp, keys) => {
  blankPath(tree, x);
  let parentHash = EMPTY;
  for (let i = fp.length - 1; i >= 0; i--) {
    tree[fp[i].node] = { encryptionKey: keys[i], parentHash, unmergedLeaves: [] };
    parentHash = parentHashOf(tree, fp[i].node, fp[i].copath);
  }
  return parentHash;
};

// who each path secret is encrypted to: the copath resolutions, minus the leaves
// this commit adds (they learn theirs from the Welcome)
const pathTargets = (fp, added, path) => {
  let fresh = new Set(added.map((a) => 2 * a.leafIndex));
  let targets = fp.map((f) => f.res.filter((n) => !fresh.has(n)));
  if (
    path.nodes.length !== fp.length ||
    path.nodes.some((n, i) => n.secrets.length !== targets[i].length)
  )
    fail("update path does not fit the tree");
  return targets;
};

const openPathSecret = (priv, leafIndex, fp, targets, path, context) => {
  let at = fp.findIndex((f) => inSubtree(f.node, 2 * leafIndex));
  let to = at < 0 ? -1 : targets[at].findIndex((n) => priv[n]);
  if (to < 0) fail("no private key for the update path");
  try {
    let { kemOutput, ciphertext } = path.nodes[at].secrets[to];
    return {
      at,
      secret: decryptWithLabel(
        priv[targets[at][to]],
        "UpdatePathNode",
        context,
        kemOutput,
        ciphertext,
      ),
    };
  } catch {
    return fail("cannot decrypt path secret");
  }
};

// private keys survive an epoch change only for nodes whose public key did
const carryKeys = (priv, before, after) =>
  Object.fromEntries(
    Object.entries(priv).filter(
      ([x]) => after[x] && before[x] && eq(after[x].encryptionKey, before[x].encryptionKey),
    ),
  );

// the state every member lands in once a commit is applied
const enterEpoch = (
  s,
  wire,
  content,
  signature,
  { tree, treeHash, extensions, priv, commitSecret, pskSecret },
) => {
  let confirmedTranscriptHash = confirmedHash(s.interimTranscriptHash, wire, content, signature);
  let next = {
    ...s,
    epoch: s.epoch + 1,
    treeHash,
    confirmedTranscriptHash,
    extensions,
    tree,
    priv,
    pending: [],
  };
  let context = enc(wContext, next);
  let joiner = joinerSecret(s.keys.init, commitSecret, context);
  let { welcome, keys, encryption } = fromJoiner(joiner, pskSecret, context);
  next.keys = keys;
  next.confirmationTag = mac(keys.confirmation, confirmedTranscriptHash);
  next.interimTranscriptHash = interimHash(confirmedTranscriptHash, next.confirmationTag);
  next.secretTree = secretTreeFor(tree, encryption);
  return { state: next, joiner, welcome };
};

const active = (s) => {
  if (s.removed) fail("this client was removed from the group", "removed");
};

const findPending = (s, ref) => s.pending.find((p) => eq(p.ref, ref));

// which cached proposals a commit of ours can carry: never our own update or
// self_remove, one proposal per leaf (leaving beats updating), one context change.
// Among several self_removes of one leaf Marmot picks the lowest message digest.
const committable = (s, inline) => {
  let me = s.leafIndex;
  let leafOf = (p) =>
    p.proposal.type === PROPOSAL.REMOVE
      ? p.proposal.removed
      : p.proposal.type === PROPOSAL.UPDATE || p.proposal.type === PROPOSAL.SELF_REMOVE
        ? p.sender
        : null;
  let rank = (p) =>
    [PROPOSAL.UPDATE, PROPOSAL.REMOVE, PROPOSAL.SELF_REMOVE].indexOf(p.proposal.type);
  let best = new Map();
  for (let p of inline) if (p.type === PROPOSAL.REMOVE) best.set(p.removed, null);
  let hasContext = inline.some((p) => p.type === PROPOSAL.GROUP_CONTEXT_EXTENSIONS);
  let signers = new Set(
    inline.filter((p) => p.type === PROPOSAL.ADD).map((p) => hex(p.keyPackage.leaf.signatureKey)),
  );
  let keep = [];
  for (let p of [...s.pending].reverse()) {
    let type = p.proposal.type;
    let leaf = leafOf(p);
    if (leaf != null) {
      if (leaf === me || 2 * leaf >= s.tree.length || !s.tree[2 * leaf]) continue;
      let cur = best.get(leaf);
      if (cur === null) continue;
      let better =
        !cur ||
        rank(p) > rank(cur) ||
        (type === PROPOSAL.SELF_REMOVE &&
          cur.proposal.type === type &&
          hex(p.digest) < hex(cur.digest));
      if (better) best.set(leaf, p);
    } else if (type === PROPOSAL.GROUP_CONTEXT_EXTENSIONS) {
      if (!hasContext) keep.push(p);
      hasContext = true;
    } else if (type === PROPOSAL.ADD) {
      let k = hex(p.proposal.keyPackage.leaf.signatureKey);
      if (!signers.has(k)) keep.push(p);
      signers.add(k);
    } else keep.push(p);
  }
  for (let p of best.values()) if (p) keep.push(p);
  return s.pending.filter((p) => keep.includes(p));
};

// (state, { proposals, includePending, refs, leaf, appData, aad, path, psks, now }) →
// { message, welcome, state, addedRefs }. `proposals` go inline, cached ones by
// reference (all that can be committed, or exactly `refs`). `leaf` replaces our
// leaf's { capabilities, extensions }; `path: false` drops the update path when no
// proposal needs one. The input state is untouched: hold on to it until the commit
// is published, then switch to the returned one. One Welcome covers every add.
export const createCommit = (state, opts = {}) => {
  active(state);
  let {
    proposals = [],
    includePending = true,
    refs,
    leaf: patch,
    aad = EMPTY,
    path: wantPath = true,
  } = opts;
  let me = state.leafIndex;
  let cached = refs
    ? refs.map((ref) => findPending(state, ref) || fail("unknown proposal reference"))
    : includePending
      ? committable(state, proposals)
      : [];
  let list = [
    ...cached.map((p) => ({ proposal: p.proposal, sender: p.sender, byRef: true, ref: p.ref })),
    ...proposals.map((proposal) => ({ proposal, sender: me, byRef: false })),
  ];
  // app_data_update is applied last and must follow a GroupContextExtensions on the wire
  let late = (e) => e.proposal.type === PROPOSAL.APP_DATA_UPDATE;
  list = [...list.filter((e) => !late(e)), ...list.filter(late)];

  let ap = applyProposals(state, list, me, { ...opts, own: true });
  let { tree, extensions, pskSecret } = ap;
  let x = 2 * me;
  let commitSecret = ZERO32;
  let path = null;
  let steps = [];
  let priv;
  if (wantPath || ap.pathRequired) {
    let fp = filteredPath(tree, x);
    let secret = randomBytes(32);
    for (let f of fp) {
      steps.push({ ...f, secret, ...deriveKeyPair(deriveSecret(secret, "node")) });
      secret = deriveSecret(secret, "path");
    }
    commitSecret = secret;
    let old = tree[x];
    let leafPriv = randomBytes(32);
    let parentHash = setPath(
      tree,
      x,
      fp,
      steps.map((st) => st.pub),
    );
    let { lifetime, signature, ...rest } = old;
    let leaf = signLeaf(
      {
        ...rest,
        encryptionKey: x25519.getPublicKey(leafPriv),
        capabilities: patch?.capabilities
          ? { ...DEFAULT_CAPS, ...patch.capabilities }
          : old.capabilities,
        extensions: patch?.extensions || old.extensions,
        source: LEAF_SOURCE.COMMIT,
        parentHash,
      },
      state.sigPriv,
      state.groupId,
      me,
    );
    checkLeaf(leaf, state.groupId, me, extensions);
    tree[x] = leaf;
    priv = { ...carryKeys(state.priv, state.tree, tree), [x]: leafPriv };
    for (let st of steps) priv[st.node] = st.priv;
    // new members learn their path secret from the Welcome instead
    let fresh = new Set(ap.added.map((a) => 2 * a.leafIndex));
    let context = enc(wContext, {
      ...state,
      epoch: state.epoch + 1,
      treeHash: rootHash(tree),
      extensions,
    });
    path = {
      leaf,
      nodes: steps.map((st) => ({
        encryptionKey: st.pub,
        secrets: st.res
          .filter((n) => !fresh.has(n))
          .map((n) =>
            encryptWithLabel(tree[n].encryptionKey, "UpdatePathNode", context, st.secret),
          ),
      })),
    };
  } else priv = carryKeys(state.priv, state.tree, tree);
  checkTreeKeys(tree);

  let content = {
    groupId: state.groupId,
    epoch: state.epoch,
    sender: { type: SENDER.MEMBER, leafIndex: me },
    aad,
    contentType: CONTENT.COMMIT,
    commit: {
      proposals: list.map((e) => (e.byRef ? { ref: e.ref } : { proposal: e.proposal })),
      path,
    },
  };
  let signature = signContent(state, WIRE.PUBLIC, content);
  let next = enterEpoch(state, WIRE.PUBLIC, content, signature, {
    tree,
    treeHash: rootHash(tree),
    extensions,
    priv,
    commitSecret,
    pskSecret,
  });
  let message = sealPublic(state, content, {
    signature,
    confirmationTag: next.state.confirmationTag,
  });

  let welcome = null;
  let addedRefs = ap.added.map((a) => keyPackageRef(a.keyPackage));
  if (ap.added.length) {
    let info = {
      context: next.state,
      extensions: [{ type: EXT.RATCHET_TREE, data: enc(wTree, tree) }],
      confirmationTag: next.state.confirmationTag,
      signer: me,
    };
    info.signature = signWithLabel(state.sigPriv, "GroupInfoTBS", enc(wGroupInfoTBS, info));
    let encryptedGroupInfo = welcomeCipher(next.welcome).encrypt(enc(wGroupInfo, info));
    let secrets = ap.added.map(({ leafIndex, keyPackage }, i) => {
      let groupSecrets = enc(wGroupSecrets, {
        joinerSecret: next.joiner,
        pathSecret: steps.find((st) => inSubtree(st.node, 2 * leafIndex))?.secret,
        psks: ap.pskIds,
      });
      return {
        ref: addedRefs[i],
        ...encryptWithLabel(keyPackage.initKey, "Welcome", encryptedGroupInfo, groupSecrets),
      };
    });
    welcome = enc(wMessage, {
      wireFormat: WIRE.WELCOME,
      welcome: { cipherSuite: 1, secrets, encryptedGroupInfo },
    });
  }
  return { message, welcome, state: next.state, addedRefs };
};

const proposalRef = (wire, content, auth) =>
  refHash(
    "MLS 1.0 Proposal Reference",
    wAuth(wContent(new Writer().u16(wire), content), auth, content.contentType).finish(),
  );

const cacheProposal = (s, wire, content, auth, message) => {
  let ref = proposalRef(wire, content, auth);
  let entry = {
    ref,
    proposal: content.proposal,
    sender: content.sender.leafIndex,
    digest: sha256(message),
  };
  return { ref, state: findPending(s, ref) ? s : { ...s, pending: [...s.pending, entry] } };
};

// a standalone proposal as a PublicMessage, cached in the returned state like anyone else's
export const createProposal = (state, proposal, { aad = EMPTY } = {}) => {
  active(state);
  if (proposal.type === PROPOSAL.UPDATE)
    fail("update proposals are not supported; commit instead", "unsupported");
  let content = {
    groupId: state.groupId,
    epoch: state.epoch,
    sender: { type: SENDER.MEMBER, leafIndex: state.leafIndex },
    aad,
    contentType: CONTENT.PROPOSAL,
    proposal,
  };
  let auth = { signature: signContent(state, WIRE.PUBLIC, content) };
  let message = sealPublic(state, content, auth);
  return { message, ...cacheProposal(state, WIRE.PUBLIC, content, auth, message) };
};

const processCommit = (s, wire, content, auth, opts) => {
  let committer = content.sender.leafIndex;
  // our own commit comes back from the relay; its state is the one createCommit returned
  if (committer === s.leafIndex) fail("commit was created by this client", "own");
  let { commit } = content;
  let list = commit.proposals.map((p) => {
    if (!p.ref) return { proposal: p.proposal, sender: committer, byRef: false };
    let cached =
      findPending(s, p.ref) ||
      fail("commit references a proposal we have not seen", "missing-proposal");
    return { proposal: cached.proposal, sender: cached.sender, byRef: true };
  });
  let ap = applyProposals(s, list, committer, opts);
  let result = {
    type: "commit",
    sender: committer,
    aad: content.aad,
    proposals: list,
    ephemeral: ap.ephemeral,
    removedSelf: ap.removedSelf,
  };
  // removed members get no path secret: the old state stays readable, the group moves on without us
  if (ap.removedSelf) return { ...result, state: { ...s, removed: true, pending: [] } };

  let { tree, extensions, pskSecret } = ap;
  let { path } = commit;
  if (!path && ap.pathRequired) fail("commit is missing its update path");
  let commitSecret = ZERO32;
  let priv;
  if (path) {
    let x = 2 * committer;
    if (path.leaf.source !== LEAF_SOURCE.COMMIT) fail("commit leaf node has the wrong source");
    checkLeaf(path.leaf, s.groupId, committer, extensions);
    if (eq(path.leaf.encryptionKey, tree[x].encryptionKey))
      fail("commit keeps the committer's old encryption key");
    let fp = filteredPath(tree, x);
    let targets = pathTargets(fp, ap.added, path);
    let parentHash = setPath(
      tree,
      x,
      fp,
      path.nodes.map((n) => n.encryptionKey),
    );
    if (!eq(parentHash, path.leaf.parentHash))
      fail("commit leaf node carries the wrong parent hash");
    tree[x] = path.leaf;
    let context = enc(wContext, { ...s, epoch: s.epoch + 1, treeHash: rootHash(tree), extensions });
    let { at, secret } = openPathSecret(s.priv, s.leafIndex, fp, targets, path, context);
    let derived = derivePath(tree, fp, at, secret);
    commitSecret = derived.commitSecret;
    priv = { ...carryKeys(s.priv, s.tree, tree), ...derived.priv };
  } else priv = carryKeys(s.priv, s.tree, tree);
  checkTreeKeys(tree);

  let next = enterEpoch(s, wire, content, auth.signature, {
    tree,
    treeHash: rootHash(tree),
    extensions,
    priv,
    commitSecret,
    pskSecret,
  });
  if (!eq(next.state.confirmationTag, auth.confirmationTag)) fail("invalid confirmation tag");
  return { ...result, state: next.state };
};

// (state, bytes, { appData, psks, now }) →
//   { type: "application", data, aad, sender, state }
//   { type: "proposal", proposal, sender, ref, aad, state }
//   { type: "commit", proposals: [{ proposal, sender, byRef }], ephemeral, removedSelf, sender, aad, state }
// Handshake may arrive as PublicMessage or PrivateMessage. Throws on anything
// invalid; e.code says why when the caller can act on it: "epoch" (try another
// retained state), "group", "own" (we sent it), "replay", "missing-proposal",
// "removed", "unsupported". When a commit removes us the returned state is the old
// one marked `removed`: it still reads its epoch but can no longer send or advance.
export const processMessage = (state, bytes, opts = {}) => {
  let m = dec(rMessage, bytes);
  let framed = m.public?.content || m.private;
  if (!framed) fail("not a group message");
  if (!eq(framed.groupId, state.groupId)) fail("message is for another group", "group");
  if (framed.epoch !== state.epoch)
    fail(`message is for epoch ${framed.epoch}, state is at ${state.epoch}`, "epoch");

  let wire = m.wireFormat;
  let s = state;
  let content, auth;
  if (m.public) ({ content, auth } = openPublic(state, m.public));
  else {
    let opened = openPrivate(state, m.private);
    ({ content, auth } = opened);
    s = { ...state, secretTree: opened.secretTree };
  }
  let sender = content.sender.leafIndex;
  if (content.contentType === CONTENT.APPLICATION)
    return { type: "application", data: content.data, aad: content.aad, sender, state: s };
  active(state);
  if (content.contentType === CONTENT.PROPOSAL)
    return {
      type: "proposal",
      proposal: content.proposal,
      sender,
      aad: content.aad,
      ...cacheProposal(s, wire, content, auth, bytes),
    };
  return processCommit(s, wire, content, auth, opts);
};

// application data as a PrivateMessage; the returned state has the ratchet moved on
export const encryptApplication = (state, data, aad = EMPTY) => {
  active(state);
  let content = {
    groupId: state.groupId,
    epoch: state.epoch,
    sender: { type: SENDER.MEMBER, leafIndex: state.leafIndex },
    aad,
    contentType: CONTENT.APPLICATION,
    data,
  };
  let { message, secretTree } = sealPrivate(state, content, {
    signature: signContent(state, WIRE.PRIVATE, content),
  });
  return { message, state: { ...state, secretTree } };
};

// MLS-Exporter (RFC 9420 §8.5)
export const exportSecret = (state, label, context, length) =>
  expandWithLabel(deriveSecret(state.keys.exporter, label), "exported", sha256(context), length);

export const epochAuthenticator = (state) => state.keys.authenticator;

export const members = (state) =>
  state.tree.flatMap((leaf, x) =>
    leaf && x % 2 === 0
      ? [
          {
            index: x / 2,
            identity: leaf.credential.identity,
            signatureKey: leaf.signatureKey,
            encryptionKey: leaf.encryptionKey,
            leaf,
          },
        ]
      : [],
  );

// not API: what tools/mls-vectors-test.js needs to run the RFC 9420 interop vectors
export const internals = {
  enc,
  dec,
  codec: {
    message: [wMessage, rMessage],
    tree: [wTree, rTree],
    proposal: [wProposal, rProposal],
    commit: [wCommit, rCommit],
    path: [wPath, rPath],
    groupSecrets: [wGroupSecrets, rGroupSecrets],
    groupInfo: [wGroupInfo, rGroupInfo],
    groupInfoTBS: [wGroupInfoTBS],
    context: [wContext, rContext],
    content: [wContent, rContent],
    auth: [wAuth, rAuth],
    leaf: [wLeaf, rLeaf],
    pskId: [wPskId, rPskId],
  },
  tree: {
    level,
    left,
    right,
    parent,
    sibling,
    rootOf,
    directPath,
    resolution,
    filteredPath,
    treeHash,
    rootHash,
  },
  ratchetTree: { verifyParentHashes, blankPath, truncate, addLeaf, checkTree, leafTBS },
  treekem: { setPath, derivePath, pathTargets, openPathSecret },
  crypto: {
    expandWithLabel,
    deriveSecret,
    deriveTreeSecret,
    refHash,
    signWithLabel,
    verifyWithLabel,
    encryptWithLabel,
    decryptWithLabel,
    deriveKeyPair,
    mac,
  },
  schedule: {
    epochKeys,
    joinerSecret,
    fromJoiner,
    welcomeCipher,
    pskSecret,
    interimHash,
    confirmedHash,
  },
  secretTree: { leafRatchets, seek, secretTreeFor },
  framing: { sealPublic, openPublic, sealPrivate, openPrivate, signContent },
  keyPackageRef,
};
