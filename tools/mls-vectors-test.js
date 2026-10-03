// src/mls.js against the RFC 9420 interop vectors (ciphersuite 1), then
// self-tests that drive a small group through the public API only.
//
//   bun run tools/mls-vectors-test.js [vectorsDir]
//
// vectorsDir holds the mls-implementations JSON files. Without one they are
// fetched once from github.com/mlswg/mls-implementations into the system
// temp dir (~10 MB). Exits non-zero on any failure.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join as joinPath } from "path";
import { tmpdir } from "os";
import { bytesToHex as hex, hexToBytes as unhex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import * as mls from "../src/mls.js";

const VECTOR_FILES = [
  "deserialization", "tree-math", "crypto-basics", "secret-tree", "message-protection", "key-schedule", "psk_secret",
  "transcript-hashes", "welcome", "tree-operations", "tree-validation", "treekem", "messages",
  "passive-client-welcome", "passive-client-handling-commit", "passive-client-random",
].map((n) => n + ".json");
const UPSTREAM = "https://raw.githubusercontent.com/mlswg/mls-implementations/main/test-vectors/";
const dir = process.argv[2] || joinPath(tmpdir(), "mls-test-vectors");
if (!process.argv[2]) {
  mkdirSync(dir, { recursive: true });
  for (const f of VECTOR_FILES) {
    if (existsSync(joinPath(dir, f))) continue;
    const res = await fetch(UPSTREAM + f);
    if (!res.ok) throw new Error(`could not fetch ${f}: ${res.status}`);
    writeFileSync(joinPath(dir, f), await res.text());
  }
}

const { internals: I, EXT, PROPOSAL } = mls;
const { enc, dec, codec } = I;
const utf8 = (s) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);
const ZERO32 = new Uint8Array(32);

const same = (a, b, what) => {
  let x = a instanceof Uint8Array ? hex(a) : JSON.stringify(a);
  let y =
    b instanceof Uint8Array
      ? hex(b)
      : typeof b === "string" && a instanceof Uint8Array
        ? b
        : JSON.stringify(b);
  if (x !== y) throw new Error(`${what}: ${String(x).slice(0, 80)} != ${String(y).slice(0, 80)}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const throws = (fn, what, code) => {
  try {
    fn();
  } catch (e) {
    if (code && e.code !== code)
      throw new Error(`${what}: expected code ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(what + ": expected an error");
};

let failed = 0;
const results = [];

// runs fn over every case; a case may return a string to say why it was skipped
const suite = (name, cases, fn) => {
  let pass = 0;
  let fail = 0;
  let skips = {};
  cases.forEach((c, i) => {
    try {
      let skipped = fn(c, i);
      if (typeof skipped === "string") skips[skipped] = (skips[skipped] || 0) + 1;
      else pass++;
    } catch (e) {
      fail++;
      if (fail <= 3) console.log(`  FAIL ${name} #${i}: ${e.message}`);
    }
  });
  failed += fail;
  let skipped = Object.entries(skips)
    .map(([why, n]) => `${n} skipped (${why})`)
    .join(", ");
  results.push(
    `${fail ? "FAIL" : "ok  "} ${name}: ${pass}/${cases.length - Object.values(skips).reduce((a, b) => a + b, 0)} passed${skipped ? ", " + skipped : ""}`,
  );
  console.log(results[results.length - 1]);
};

const load = (file, all) => {
  let path = joinPath(dir, file);
  if (!existsSync(path)) return null;
  let cases = JSON.parse(readFileSync(path, "utf8"));
  return all ? cases : cases.filter((c) => c.cipher_suite === 1);
};

const vectors = (name, file, fn, all = false) => {
  let cases = load(file, all);
  if (!cases) {
    failed++;
    console.log(`FAIL ${name}: ${file} not found in ${dir}`);
    return;
  }
  suite(name, cases, fn);
};

// ---- official vectors ----

vectors(
  "deserialization",
  "deserialization.json",
  (c) => same(new mls.Reader(unhex(c.vlbytes_header)).varint(), c.length, "length"),
  true,
);

vectors(
  "tree-math",
  "tree-math.json",
  (c) => {
    let T = I.tree;
    let width = c.n_nodes;
    same(2 * c.n_leaves - 1, width, "n_nodes");
    same(T.rootOf(width), c.root, "root");
    for (let x = 0; x < width; x++) {
      same(x % 2 ? T.left(x) : null, c.left[x], "left " + x);
      same(x % 2 ? T.right(x) : null, c.right[x], "right " + x);
      same(x === c.root ? null : T.parent(x), c.parent[x], "parent " + x);
      same(x === c.root ? null : T.sibling(x), c.sibling[x], "sibling " + x);
    }
  },
  true,
);

vectors("crypto-basics", "crypto-basics.json", (c) => {
  let C = I.crypto;
  let v = c.ref_hash;
  same(C.refHash(v.label, unhex(v.value)), v.out, "ref_hash");
  v = c.expand_with_label;
  same(
    C.expandWithLabel(unhex(v.secret), v.label, unhex(v.context), v.length),
    v.out,
    "expand_with_label",
  );
  v = c.derive_secret;
  same(C.deriveSecret(unhex(v.secret), v.label), v.out, "derive_secret");
  v = c.derive_tree_secret;
  same(
    C.deriveTreeSecret(unhex(v.secret), v.label, v.generation, v.length),
    v.out,
    "derive_tree_secret",
  );
  v = c.sign_with_label;
  ok(
    C.verifyWithLabel(unhex(v.pub), v.label, unhex(v.content), unhex(v.signature)),
    "verify vector signature",
  );
  let sig = C.signWithLabel(unhex(v.priv), v.label, unhex(v.content));
  ok(C.verifyWithLabel(unhex(v.pub), v.label, unhex(v.content), sig), "verify own signature");
  ok(
    !C.verifyWithLabel(unhex(v.pub), v.label + "x", unhex(v.content), sig),
    "signature bound to label",
  );
  v = c.encrypt_with_label;
  let args = [unhex(v.priv), v.label, unhex(v.context)];
  same(
    C.decryptWithLabel(...args, unhex(v.kem_output), unhex(v.ciphertext)),
    v.plaintext,
    "decrypt vector",
  );
  let own = C.encryptWithLabel(unhex(v.pub), v.label, unhex(v.context), unhex(v.plaintext));
  same(C.decryptWithLabel(...args, own.kemOutput, own.ciphertext), v.plaintext, "decrypt own");
});

vectors("secret-tree", "secret-tree.json", (c) => {
  let C = I.crypto;
  let sd = c.sender_data;
  let sample = unhex(sd.ciphertext).subarray(0, 32);
  same(
    C.expandWithLabel(unhex(sd.sender_data_secret), "key", sample, 16),
    sd.key,
    "sender data key",
  );
  same(
    C.expandWithLabel(unhex(sd.sender_data_secret), "nonce", sample, 12),
    sd.nonce,
    "sender data nonce",
  );
  let width = 2 * c.leaves.length - 1;
  let st = I.secretTree.secretTreeFor({ length: width }, unhex(c.encryption_secret));
  c.leaves.forEach((gens, leaf) => {
    st = I.secretTree.leafRatchets(st, width, 2 * leaf);
    let { h, a } = st.ratchets[2 * leaf];
    for (let g of gens) {
      let app = I.secretTree.seek(a, g.generation);
      let hs = I.secretTree.seek(h, g.generation);
      same(app.kn.key, g.application_key, "application key");
      same(app.kn.nonce, g.application_nonce, "application nonce");
      same(hs.kn.key, g.handshake_key, "handshake key");
      same(hs.kn.nonce, g.handshake_nonce, "handshake nonce");
      a = app.r;
      h = hs.r;
    }
  });
  ok(Object.keys(st.nodes).length === 0, "all node secrets consumed");
});

// a two-leaf state with just enough in it for the framing layer
const framingState = (c, leafIndex) => {
  let leaf = (signatureKey) => ({ signatureKey, encryptionKey: EMPTY });
  let tree = [leaf(ZERO32), null, leaf(unhex(c.signature_pub))];
  return {
    version: 1,
    cipherSuite: 1,
    groupId: unhex(c.group_id),
    epoch: c.epoch,
    treeHash: unhex(c.tree_hash),
    confirmedTranscriptHash: unhex(c.confirmed_transcript_hash),
    extensions: [],
    tree,
    leafIndex,
    sigPriv: unhex(c.signature_priv),
    keys: { senderData: unhex(c.sender_data_secret), membership: unhex(c.membership_key) },
    secretTree: I.secretTree.secretTreeFor(tree, unhex(c.encryption_secret)),
  };
};

vectors("message-protection", "message-protection.json", (c) => {
  let F = I.framing;
  let receiver = framingState(c, 0);
  let sender = framingState(c, 1);
  let message = (h) => dec(codec.message[1], unhex(h));
  let body = { proposal: codec.proposal[0], commit: codec.commit[0] };
  let check = (content, kind) => {
    if (kind === "application") return same(content.data, c.application, "application data");
    same(enc(body[kind], content[kind]), c[kind], kind + " content");
  };
  let contentOf = (kind, contentType) => {
    let content = {
      groupId: sender.groupId,
      epoch: sender.epoch,
      sender: { type: 1, leafIndex: 1 },
      aad: utf8("aad"),
      contentType,
    };
    if (kind === "application") content.data = unhex(c.application);
    else content[kind] = dec(codec[kind][1], unhex(c[kind]));
    return content;
  };
  [
    ["application", 1],
    ["proposal", 2],
    ["commit", 3],
  ].forEach(([kind, contentType]) => {
    let authFor = (wire) => {
      let content = contentOf(kind, contentType);
      let auth = { signature: F.signContent(sender, wire, content) };
      if (kind === "commit") auth.confirmationTag = ZERO32;
      return { content, auth };
    };
    if (kind !== "application") {
      check(F.openPublic(receiver, message(c[kind + "_pub"]).public).content, kind);
      let { content, auth } = authFor(1);
      check(
        F.openPublic(receiver, message(hex(F.sealPublic(sender, content, auth))).public).content,
        kind,
      );
      let bad = dec(codec.message[1], F.sealPublic(sender, content, auth));
      bad.public.membershipTag[0] ^= 1;
      throws(() => F.openPublic(receiver, bad.public), "tampered membership tag");
    }
    check(F.openPrivate(receiver, message(c[kind + "_priv"]).private).content, kind);
    let { content, auth } = authFor(2);
    let sealed = F.sealPrivate(sender, content, auth, 7);
    let opened = F.openPrivate(receiver, message(hex(sealed.message)).private);
    check(opened.content, kind);
    same(opened.content.aad, utf8("aad"), "aad");
    throws(
      () =>
        F.openPrivate(
          { ...receiver, secretTree: opened.secretTree },
          message(hex(sealed.message)).private,
        ),
      "replay",
      "replay",
    );
    throws(() => F.openPrivate(sender, message(hex(sealed.message)).private), "own message", "own");
  });
  let content = contentOf("application", 1);
  let auth = { signature: F.signContent(sender, 1, content) };
  throws(
    () => F.openPublic(receiver, dec(codec.message[1], F.sealPublic(sender, content, auth)).public),
    "public application",
  );
});

vectors("key-schedule", "key-schedule.json", (c) => {
  let S = I.schedule;
  let init = unhex(c.initial_init_secret);
  c.epochs.forEach((e, epoch) => {
    let ctx = {
      version: 1,
      cipherSuite: 1,
      groupId: unhex(c.group_id),
      epoch,
      treeHash: unhex(e.tree_hash),
      confirmedTranscriptHash: unhex(e.confirmed_transcript_hash),
      extensions: [],
    };
    let context = enc(codec.context[0], ctx);
    same(context, e.group_context, "group_context");
    let joiner = S.joinerSecret(init, unhex(e.commit_secret), context);
    same(joiner, e.joiner_secret, "joiner_secret");
    let { welcome, keys, encryption } = S.fromJoiner(joiner, unhex(e.psk_secret), context);
    same(welcome, e.welcome_secret, "welcome_secret");
    same(encryption, e.encryption_secret, "encryption_secret");
    same(keys.senderData, e.sender_data_secret, "sender_data_secret");
    same(keys.exporter, e.exporter_secret, "exporter_secret");
    same(keys.external, e.external_secret, "external_secret");
    same(keys.confirmation, e.confirmation_key, "confirmation_key");
    same(keys.membership, e.membership_key, "membership_key");
    same(keys.resumption, e.resumption_psk, "resumption_psk");
    same(keys.authenticator, e.epoch_authenticator, "epoch_authenticator");
    same(keys.init, e.init_secret, "init_secret");
    same(I.crypto.deriveKeyPair(keys.external).pub, e.external_pub, "external_pub");
    let x = e.exporter;
    same(mls.exportSecret({ keys }, x.label, unhex(x.context), x.length), x.secret, "exporter");
    init = keys.init;
  });
});

vectors("psk-secret", "psk_secret.json", (c) => {
  let psks = c.psks.map((p) => ({
    id: { psktype: 1, pskId: unhex(p.psk_id), nonce: unhex(p.psk_nonce) },
    psk: unhex(p.psk),
  }));
  same(I.schedule.pskSecret(psks), c.psk_secret, "psk_secret");
});

vectors("transcript-hashes", "transcript-hashes.json", (c) => {
  let { wire, content, auth } = dec((r) => {
    let wire = r.u16();
    let content = codec.content[1](r);
    return { wire, content, auth: codec.auth[1](r, content.contentType) };
  }, unhex(c.authenticated_content));
  let confirmed = I.schedule.confirmedHash(
    unhex(c.interim_transcript_hash_before),
    wire,
    content,
    auth.signature,
  );
  same(confirmed, c.confirmed_transcript_hash_after, "confirmed_transcript_hash");
  same(
    I.crypto.mac(unhex(c.confirmation_key), confirmed),
    auth.confirmationTag,
    "confirmation_tag",
  );
  same(
    I.schedule.interimHash(confirmed, auth.confirmationTag),
    c.interim_transcript_hash_after,
    "interim_transcript_hash",
  );
});

vectors("welcome", "welcome.json", (c) => {
  let { welcome } = dec(codec.message[1], unhex(c.welcome));
  let kp = mls.parseKeyPackage(unhex(c.key_package));
  let mine = welcome.secrets.find((s) => hex(s.ref) === hex(kp.ref));
  ok(mine, "welcome addressed to the key package");
  let secrets = dec(
    codec.groupSecrets[1],
    I.crypto.decryptWithLabel(
      unhex(c.init_priv),
      "Welcome",
      welcome.encryptedGroupInfo,
      mine.kemOutput,
      mine.ciphertext,
    ),
  );
  // the welcome secret does not depend on the context, so any will do to get at the GroupInfo
  let cipher = I.schedule.welcomeCipher(
    I.schedule.fromJoiner(secrets.joinerSecret, ZERO32, EMPTY).welcome,
  );
  let info = dec(codec.groupInfo[1], cipher.decrypt(welcome.encryptedGroupInfo));
  ok(
    I.crypto.verifyWithLabel(
      unhex(c.signer_pub),
      "GroupInfoTBS",
      enc(codec.groupInfoTBS[0], info),
      info.signature,
    ),
    "GroupInfo signature",
  );
  let { keys } = I.schedule.fromJoiner(
    secrets.joinerSecret,
    ZERO32,
    enc(codec.context[0], info.context),
  );
  same(
    I.crypto.mac(keys.confirmation, info.context.confirmedTranscriptHash),
    info.confirmationTag,
    "confirmation_tag",
  );
});

vectors("tree-operations", "tree-operations.json", (c) => {
  let R = I.ratchetTree;
  let tree = dec(codec.tree[1], unhex(c.tree_before));
  same(I.tree.rootHash(tree), c.tree_hash_before, "tree_hash_before");
  let p = dec(codec.proposal[1], unhex(c.proposal));
  if (p.type === PROPOSAL.ADD) R.addLeaf(tree, p.keyPackage.leaf);
  else if (p.type === PROPOSAL.UPDATE) {
    R.blankPath(tree, 2 * c.proposal_sender);
    tree[2 * c.proposal_sender] = p.leaf;
  } else if (p.type === PROPOSAL.REMOVE) {
    R.blankPath(tree, 2 * p.removed);
    tree[2 * p.removed] = null;
    R.truncate(tree);
  } else throw new Error("unexpected proposal type " + p.type);
  same(enc(codec.tree[0], tree), c.tree_after, "tree_after");
  same(I.tree.rootHash(tree), c.tree_hash_after, "tree_hash_after");
});

vectors("tree-validation", "tree-validation.json", (c) => {
  let tree = dec(codec.tree[1], unhex(c.tree));
  same(enc(codec.tree[0], tree), c.tree, "tree round trip");
  c.tree_hashes.forEach((h, x) => same(I.tree.treeHash(tree, x), h, "tree hash " + x));
  c.resolutions.forEach((r, x) => same(I.tree.resolution(tree, x), r, "resolution " + x));
  ok(I.ratchetTree.verifyParentHashes(tree), "parent hashes");
  // leaf signatures, capabilities, unmerged leaves, key uniqueness, parent hashes
  I.ratchetTree.checkTree(tree, unhex(c.group_id), []);
});

vectors("treekem", "treekem.json", (c) => {
  let K = I.treekem;
  let T = I.tree;
  let tree = dec(codec.tree[1], unhex(c.ratchet_tree));
  let base = {
    version: 1,
    cipherSuite: 1,
    groupId: unhex(c.group_id),
    epoch: c.epoch,
    confirmedTranscriptHash: unhex(c.confirmed_transcript_hash),
    extensions: [],
  };
  // what each member knows: its leaf key plus the node keys its path secrets derive
  let privs = {};
  for (let lp of c.leaves_private) {
    let priv = { [2 * lp.index]: unhex(lp.encryption_priv) };
    same(
      x25519.getPublicKey(priv[2 * lp.index]),
      tree[2 * lp.index].encryptionKey,
      "leaf key " + lp.index,
    );
    for (let ps of lp.path_secrets) {
      let kp = I.crypto.deriveKeyPair(I.crypto.deriveSecret(unhex(ps.path_secret), "node"));
      same(kp.pub, tree[ps.node].encryptionKey, "node key " + ps.node);
      priv[ps.node] = kp.priv;
    }
    privs[lp.index] = priv;
  }
  let receive = (after, fp, path, context, leaf) => {
    let { at, secret } = K.openPathSecret(
      privs[leaf],
      leaf,
      fp,
      K.pathTargets(fp, [], path),
      path,
      context,
    );
    return { secret, commitSecret: K.derivePath(after, fp, at, secret).commitSecret };
  };
  for (let up of c.update_paths) {
    let path = dec(codec.path[1], unhex(up.update_path));
    let x = 2 * up.sender;
    let fp = T.filteredPath(tree, x);
    let after = tree.slice();
    same(
      K.setPath(
        after,
        x,
        fp,
        path.nodes.map((n) => n.encryptionKey),
      ),
      path.leaf.parentHash,
      "leaf parent hash",
    );
    after[x] = path.leaf;
    let treeHash = T.rootHash(after);
    same(treeHash, up.tree_hash_after, "tree_hash_after");
    ok(I.ratchetTree.verifyParentHashes(after), "parent hashes after the path");
    let context = enc(codec.context[0], { ...base, treeHash });

    // a path of our own from the same sender, opened by everybody else
    let secret = crypto.getRandomValues(new Uint8Array(32));
    let own = { leaf: path.leaf, nodes: [] };
    for (let f of fp) {
      let kp = I.crypto.deriveKeyPair(I.crypto.deriveSecret(secret, "node"));
      let secrets = f.res.map((n) =>
        I.crypto.encryptWithLabel(tree[n].encryptionKey, "UpdatePathNode", context, secret),
      );
      own.nodes.push({ encryptionKey: kp.pub, secrets });
      secret = I.crypto.deriveSecret(secret, "path");
    }
    let ownAfter = tree.slice();
    K.setPath(
      ownAfter,
      x,
      fp,
      own.nodes.map((n) => n.encryptionKey),
    );

    for (let lp of c.leaves_private) {
      if (lp.index === up.sender) {
        same(up.path_secrets[lp.index], null, "no path secret for the sender");
        continue;
      }
      let got = receive(after, fp, path, context, lp.index);
      same(got.secret, up.path_secrets[lp.index], "path secret for leaf " + lp.index);
      same(got.commitSecret, up.commit_secret, "commit secret for leaf " + lp.index);
      same(
        receive(ownAfter, fp, own, context, lp.index).commitSecret,
        secret,
        "own path commit secret",
      );
    }
  }
});

const PROPOSAL_FIELDS = {
  add_proposal: 1,
  update_proposal: 2,
  remove_proposal: 3,
  pre_shared_key_proposal: 4,
  re_init_proposal: 5,
  external_init_proposal: 6,
  group_context_extensions_proposal: 7,
};
const MESSAGE_FIELDS = [
  "mls_welcome",
  "mls_group_info",
  "mls_key_package",
  "public_message_application",
  "public_message_proposal",
  "public_message_commit",
  "private_message",
];

vectors(
  "messages",
  "messages.json",
  (c) => {
    let trip = ([w, r], h, what) => same(enc(w, dec(r, unhex(h))), h, what);
    for (let f of MESSAGE_FIELDS) trip(codec.message, c[f], f);
    trip(codec.tree, c.ratchet_tree, "ratchet_tree");
    trip(codec.groupSecrets, c.group_secrets, "group_secrets");
    trip(codec.commit, c.commit, "commit");
    // the vectors hold bare proposal bodies; ours carry their type
    for (let [f, type] of Object.entries(PROPOSAL_FIELDS))
      trip(codec.proposal, hex(new mls.Writer().u16(type).finish()) + c[f], f);
    for (let f of MESSAGE_FIELDS) mls.decodeMessage(unhex(c[f]));
  },
  true,
);

const snapshot = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? "0x" + hex(x) : x));

// processMessage, checking on the way that the input state is left alone
const step = (state, bytes, opts) => {
  let before = snapshot(state);
  let out = mls.processMessage(state, bytes, opts);
  ok(snapshot(state) === before, "processMessage mutated its input state");
  return out;
};

const passive = (c) => {
  let kp = mls.parseKeyPackage(unhex(c.key_package));
  let sig = { priv: unhex(c.signature_priv), pub: ed25519.getPublicKey(unhex(c.signature_priv)) };
  same(sig.pub, kp.leaf.signatureKey, "signature key");
  same(x25519.getPublicKey(unhex(c.init_priv)), kp.initKey, "init key");
  let psks = Object.fromEntries(c.external_psks.map((p) => [p.psk_id, unhex(p.psk)]));
  try {
    let state = mls.joinWelcome(unhex(c.welcome), {
      keyPackage: unhex(c.key_package),
      secrets: { initPriv: unhex(c.init_priv), encPriv: unhex(c.encryption_priv) },
      sig,
      ratchetTree: c.ratchet_tree ? unhex(c.ratchet_tree) : undefined,
      psks,
    });
    same(
      mls.epochAuthenticator(state),
      c.initial_epoch_authenticator,
      "initial epoch authenticator",
    );
    c.epochs.forEach((e, i) => {
      for (let p of e.proposals) state = step(state, unhex(p), { psks }).state;
      let out = step(state, unhex(e.commit), { psks });
      ok(out.type === "commit" && !out.removedSelf, "commit applied");
      psks["resumption:" + state.epoch] = state.keys.resumption;
      state = structuredClone(out.state);
      same(
        mls.epochAuthenticator(state),
        e.epoch_authenticator,
        "epoch authenticator after commit " + i,
      );
    });
  } catch (e) {
    if (e.code === "unsupported")
      return e.message.replace(/^mls: /, "").replace(/ [0-9a-f]{16,}$/, "");
    throw e;
  }
};

vectors("passive-client-welcome", "passive-client-welcome.json", passive);
vectors("passive-client-handling-commit", "passive-client-handling-commit.json", passive);
vectors("passive-client-random", "passive-client-random.json", passive);

// ---- self-tests: a group driven through the public API ----

const COMPONENT = 0x8001;
const caps = {
  extensions: [EXT.APP_DATA_DICTIONARY, 0xf2f0],
  proposals: [8, 9, 10],
  credentials: [1],
};
const requiredCapsFor = (extensions) =>
  new mls.Writer()
    .list(extensions, (w, n) => w.u16(n))
    .list([8, 9, 10], (w, n) => w.u16(n))
    .list([1], (w, n) => w.u16(n))
    .finish();
const groupExtensions = [
  { type: EXT.REQUIRED_CAPABILITIES, data: requiredCapsFor([EXT.APP_DATA_DICTIONARY]) },
  { type: EXT.APP_DATA_DICTIONARY, data: mls.encodeDict([{ id: 1, data: utf8("components") }]) },
];

const person = (name) => {
  let sig = mls.generateSignatureKeyPair();
  let kp = mls.generateKeyPackage({ sig, identity: utf8(name), capabilities: caps });
  return { name, sig, kp };
};

const agree = (states, what) => {
  let [first, ...rest] = states;
  for (let s of rest) {
    same(s.epoch, first.epoch, what + ": epoch");
    same(s.treeHash, first.treeHash, what + ": treeHash");
    same(
      s.confirmedTranscriptHash,
      first.confirmedTranscriptHash,
      what + ": confirmedTranscriptHash",
    );
    same(s.extensions, first.extensions, what + ": extensions");
    same(
      mls.exportSecret(s, "marmot", utf8("ctx"), 32),
      mls.exportSecret(first, "marmot", utf8("ctx"), 32),
      what + ": exporter",
    );
    same(mls.epochAuthenticator(s), mls.epochAuthenticator(first), what + ": epoch authenticator");
    same(
      mls.members(s).map((m) => [m.index, hex(m.identity)]),
      mls.members(first).map((m) => [m.index, hex(m.identity)]),
      what + ": members",
    );
  }
};

const join = (p, welcome) =>
  mls.joinWelcome(welcome, { keyPackage: p.kp.keyPackage, secrets: p.kp.secrets, sig: p.sig });

// everybody in `others` applies a commit; returns their new states
const apply = (others, message, opts) =>
  others.map((s) => {
    let out = step(s, message, opts);
    ok(out.type === "commit", "commit processed");
    return out;
  });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("key packages", () => {
  let p = person("alice");
  let parsed = mls.parseKeyPackage(p.kp.keyPackage);
  same(mls.parseKeyPackage(p.kp.message).ref, p.kp.ref, "ref from either framing");
  same(parsed.keyPackage, p.kp.keyPackage, "bytes");
  same(parsed.leaf.credential.identity, utf8("alice"), "identity");
  same(parsed.leaf.capabilities.proposals, [8, 9, 10], "capabilities");
  ok(parsed.cipherSuite === 1 && parsed.version === 1, "suite and version");
  let peek = mls.decodeMessage(p.kp.message);
  ok(peek.wireFormat === "key_package" && hex(peek.ref) === hex(p.kp.ref), "decodeMessage");
  let bad = p.kp.keyPackage.slice();
  bad[bad.length - 1] ^= 1;
  throws(() => mls.parseKeyPackage(bad), "tampered key package");
  let w = new mls.Writer().vec(new Uint8Array(70)).finish();
  same(new mls.Reader(w).vec().length, 70, "two-byte vector length");
  throws(
    () => new mls.Reader(Uint8Array.of(0x40, 0x05, 1, 2, 3, 4, 5)).vec(),
    "non-minimal vector length",
  );
});

test("dictionary codec", () => {
  let bytes = mls.encodeDict([
    { id: 9, data: utf8("b") },
    { id: 2, data: utf8("a") },
  ]);
  same(
    mls.decodeDict(bytes).map((e) => e.id),
    [2, 9],
    "sorted",
  );
  same(mls.dictOf([{ type: EXT.APP_DATA_DICTIONARY, data: bytes }])[1].data, utf8("b"), "dictOf");
  same(mls.dictOf([]), [], "absent dictionary");
  throws(
    () =>
      mls.encodeDict([
        { id: 1, data: EMPTY },
        { id: 1, data: EMPTY },
      ]),
    "duplicate ids",
  );
  let unsorted = new mls.Writer().list([9, 2], (w, id) => w.u16(id).vec(EMPTY)).finish();
  throws(() => mls.decodeDict(unsorted), "unsorted dictionary");
});

test("unknown types round-trip", () => {
  let { codec } = I;
  let grease = { type: 0x0a0a, data: utf8("grease") };
  same(dec(codec.proposal[1], enc(codec.proposal[0], grease)), grease, "GREASE proposal");
  let alice = person("alice");
  let exts = [{ type: 0xf2f0, data: utf8("x") }];
  let kp = mls.generateKeyPackage({
    sig: alice.sig,
    identity: "alice",
    capabilities: caps,
    leafExtensions: exts,
    extensions: [{ type: 0x1a1a, data: EMPTY }],
  });
  let parsed = mls.parseKeyPackage(kp.message);
  same(parsed.leaf.extensions, exts, "leaf extension");
  same(parsed.extensions, [{ type: 0x1a1a, data: EMPTY }], "key package extension");
  throws(
    () => mls.generateKeyPackage({ sig: alice.sig, identity: "a", leafExtensions: exts }),
    "extension outside capabilities",
  );
});

test("group lifecycle", () => {
  let [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map(person);
  let groupId = crypto.getRandomValues(new Uint8Array(32));
  let a = mls.createGroup({
    groupId,
    sig: alice.sig,
    identity: utf8("alice"),
    capabilities: caps,
    extensions: groupExtensions,
  });
  ok(a.epoch === 0 && a.leafIndex === 0 && mls.members(a).length === 1, "fresh group");

  // add two members in one commit
  let before = snapshot(a);
  let c1 = mls.createCommit(a, {
    proposals: [mls.proposeAdd(bob.kp.keyPackage), mls.proposeAdd(carol.kp.message)],
  });
  ok(snapshot(a) === before, "createCommit left its input alone");
  ok(c1.welcome && c1.addedRefs.length === 2, "one welcome for both");
  same(c1.addedRefs, [bob.kp.ref, carol.kp.ref], "added refs");
  same(mls.decodeMessage(c1.welcome).refs, [bob.kp.ref, carol.kp.ref], "welcome refs");
  let peek = mls.decodeMessage(c1.message);
  ok(
    peek.wireFormat === "public" && peek.contentType === "commit" && peek.epoch === 0,
    "commit is a PublicMessage",
  );
  let a0 = a;
  a = c1.state;
  let b = join(bob, c1.welcome);
  let c = join(carol, c1.welcome);
  ok(b.joinedVia === 0 && c.joinedVia === 0, "joinedVia");
  ok(b.leafIndex === 1 && c.leafIndex === 2, "leaf indices");
  agree([a, b, c], "after adds");
  throws(() => join(dave, c1.welcome), "welcome for somebody else", "not-for-us");
  throws(() => step(a, c1.message), "stale commit", "epoch");
  throws(() => step(a0, c1.message), "own commit", "own");

  // application messages in every direction, out of order, replayed
  let states = { a, b, c };
  for (let from of ["a", "b", "c"]) {
    let sent = [];
    for (let i = 0; i < 4; i++) {
      let out = mls.encryptApplication(states[from], utf8(`${from}${i}`), utf8("aad" + i));
      states[from] = out.state;
      sent.push(out.message);
    }
    ok(mls.decodeMessage(sent[0]).wireFormat === "private", "application is a PrivateMessage");
    for (let to of ["a", "b", "c"]) {
      if (to === from) {
        throws(() => step(states[to], sent[0]), "own application message", "own");
        continue;
      }
      for (let i of [2, 0, 3, 1]) {
        let out = step(states[to], sent[i]);
        ok(
          out.type === "application" && out.sender === states[from].leafIndex,
          "application sender",
        );
        same(out.data, utf8(`${from}${i}`), "application data");
        same(out.aad, utf8("aad" + i), "application aad");
        states[to] = out.state;
      }
      throws(() => step(states[to], sent[1]), "replay", "replay");
      let bad = sent[0].slice();
      bad[bad.length - 1] ^= 1;
      throws(() => step(states[to], bad), "tampered ciphertext");
    }
  }
  ({ a, b, c } = states);

  // an update-only commit by a non-creator
  let epoch1 = { a, b, c };
  let late = mls.encryptApplication(a, utf8("late")).message;
  let c2 = mls.createCommit(b);
  ok(c2.welcome === null, "no welcome without adds");
  b = c2.state;
  [a, c] = apply([a, c], c2.message).map((o) => o.state);
  agree([a, b, c], "after update");
  ok(
    hex(mls.members(a)[1].encryptionKey) !== hex(mls.members(epoch1.a)[1].encryptionKey),
    "committer rotated its leaf key",
  );

  // old states still read their own epoch
  same(step(epoch1.b, late).data, utf8("late"), "old epoch state decrypts");
  throws(() => step(b, late), "old message on the new epoch", "epoch");

  // a tampered commit is refused
  let c3 = mls.createCommit(c, {
    proposals: [mls.proposeAdd(dave.kp.keyPackage)],
    aad: utf8("commit aad"),
  });
  let bad = c3.message.slice();
  bad[bad.length - 40] ^= 1;
  throws(() => step(a, bad), "tampered commit");
  let outs = apply([a, b], c3.message);
  same(outs[0].aad, utf8("commit aad"), "commit aad");
  ok(
    outs[0].proposals.length === 1 &&
      outs[0].proposals[0].proposal.type === PROPOSAL.ADD &&
      !outs[0].proposals[0].byRef,
    "commit proposals",
  );
  [a, b] = outs.map((o) => o.state);
  c = c3.state;
  let d = join(dave, c3.welcome);
  ok(d.joinedVia === 2 && d.leafIndex === 3, "dave joined via carol");
  agree([a, b, c, d], "after adding dave");

  // remove carol
  let c4 = mls.createCommit(a, { proposals: [mls.proposeRemove(2)] });
  a = c4.state;
  [b, d] = apply([b, d], c4.message).map((o) => o.state);
  let gone = step(c, c4.message);
  ok(
    gone.removedSelf && gone.state.removed && gone.state.epoch === c.epoch,
    "carol learns she was removed",
  );
  throws(
    () => mls.encryptApplication(gone.state, utf8("x")),
    "removed member cannot send",
    "removed",
  );
  same(
    mls.members(a).map((m) => m.index),
    [0, 1, 3],
    "members after remove",
  );
  agree([a, b, d], "after remove");
  let secret = mls.encryptApplication(a, utf8("after carol"));
  a = secret.state;
  throws(() => step(c, secret.message), "removed member cannot read", "epoch");
  b = step(b, secret.message).state;
  d = step(d, secret.message).state;

  // app_data_update, inline: update, then remove
  let c5 = mls.createCommit(b, { proposals: [mls.proposeAppDataUpdate(COMPONENT, utf8("v1"))] });
  b = c5.state;
  [a, d] = apply([a, d], c5.message).map((o) => o.state);
  agree([a, b, d], "after app_data_update");
  same(
    mls.dictOf(a.extensions).map((e) => [e.id, hex(e.data)]),
    [
      [1, hex(utf8("components"))],
      [COMPONENT, hex(utf8("v1"))],
    ],
    "dictionary after update",
  );
  same(
    a.extensions[a.extensions.length - 1].type,
    EXT.APP_DATA_DICTIONARY,
    "dictionary moved to the end",
  );

  // the caller's hook decides what an update means, on both sides
  let append = (id, current, updates) =>
    updates.reduce((acc, u) => Uint8Array.of(...acc, ...u), current || EMPTY);
  let c6 = mls.createCommit(d, {
    proposals: [
      mls.proposeAppDataUpdate(COMPONENT, utf8("+2")),
      mls.proposeAppDataUpdate(COMPONENT, utf8("+3")),
    ],
    appData: append,
  });
  d = c6.state;
  throws(() => step(a, c6.message, { appData: () => undefined }), "hook rejects the update");
  throws(() => step(a, c6.message), "default rule disagrees with the committer's hook");
  [a, b] = apply([a, b], c6.message, { appData: append }).map((o) => o.state);
  agree([a, b, d], "after hooked app_data_update");
  same(mls.dictOf(b.extensions)[1].data, utf8("v1+2+3"), "hook result");

  throws(
    () =>
      mls.createCommit(a, {
        proposals: [
          mls.proposeAppDataUpdate(COMPONENT, utf8("x")),
          mls.proposeAppDataUpdate(COMPONENT, null),
        ],
      }),
    "update and remove of one component",
  );
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeAppDataUpdate(0x7777, null)] }),
    "remove of an absent component",
  );
  let c7 = mls.createCommit(a, { proposals: [mls.proposeAppDataUpdate(COMPONENT, null)] });
  a = c7.state;
  [b, d] = apply([b, d], c7.message).map((o) => o.state);
  agree([a, b, d], "after app_data_update remove");
  same(
    mls.dictOf(d.extensions).map((e) => e.id),
    [1],
    "dictionary after remove",
  );

  // with app_data_update required, GroupContextExtensions may not touch the dictionary
  let swapped = [groupExtensions[0], { type: EXT.APP_DATA_DICTIONARY, data: mls.encodeDict([]) }];
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeGroupContextExtensions(swapped)] }),
    "dictionary change through GroupContextExtensions",
  );
  throws(
    () =>
      mls.createCommit(a, {
        proposals: [
          mls.proposeGroupContextExtensions([...a.extensions, { type: 0xf2f0, data: EMPTY }]),
        ],
      }),
    "context extension that is not required",
  );
  let extended = [
    { type: EXT.REQUIRED_CAPABILITIES, data: requiredCapsFor([EXT.APP_DATA_DICTIONARY, 0xf2f0]) },
    { type: 0xf2f0, data: utf8("marker") },
    a.extensions.find((e) => e.type === EXT.APP_DATA_DICTIONARY),
  ];
  let c8 = mls.createCommit(b, {
    proposals: [
      mls.proposeGroupContextExtensions(extended),
      mls.proposeAppEphemeral(COMPONENT, utf8("once")),
    ],
  });
  b = c8.state;
  outs = apply([a, d], c8.message);
  same(
    outs[0].ephemeral,
    [{ componentId: COMPONENT, data: utf8("once"), sender: 1 }],
    "app_ephemeral surfaced",
  );
  [a, d] = outs.map((o) => o.state);
  agree([a, b, d], "after GroupContextExtensions");
  same(a.extensions, extended, "extensions replaced");

  // standalone self_remove, committed by somebody else
  throws(() => mls.createCommit(a, { proposals: [mls.proposeSelfRemove()] }), "inline self_remove");
  let leave = mls.createProposal(d, mls.proposeSelfRemove());
  d = leave.state;
  peek = mls.decodeMessage(leave.message);
  ok(
    peek.wireFormat === "public" && peek.contentType === "proposal",
    "proposal is a PublicMessage",
  );
  let seen = [a, b].map((s) => step(s, leave.message));
  ok(
    seen.every(
      (o) => o.type === "proposal" && o.sender === 3 && o.proposal.type === PROPOSAL.SELF_REMOVE,
    ),
    "proposal processed",
  );
  same(seen[0].ref, leave.ref, "proposal ref");
  [a, b] = seen.map((o) => o.state);
  ok(step(a, leave.message).state.pending.length === 1, "duplicate proposal cached once");
  // the leaver's own commit simply leaves its self_remove out
  let own = mls.createCommit(d);
  ok(mls.members(own.state).length === 3, "leaver cannot commit its own self_remove");
  throws(() => mls.createCommit(d, { refs: [leave.ref] }), "leaver forcing its own self_remove");
  let c9 = mls.createCommit(a);
  a = c9.state;
  outs = apply([b], c9.message);
  ok(
    outs[0].proposals[0].byRef && outs[0].proposals[0].sender === 3,
    "self_remove committed by reference",
  );
  [b] = outs.map((o) => o.state);
  gone = step(d, c9.message);
  ok(gone.removedSelf, "dave learns he left");
  same(
    mls.members(a).map((m) => m.index),
    [0, 1],
    "members after self_remove",
  );
  ok(a.tree.length === 3, "tree truncated");
  agree([a, b], "after self_remove");
  // a commit that references a proposal we never saw
  throws(() => step(epoch1.c, c2.message) && step(c, c9.message), "unknown epoch", "epoch");

  // structuredClone survives a round trip and keeps working
  let a2 = structuredClone(a);
  let b2 = structuredClone(b);
  ok(snapshot(a2) === snapshot(a), "clone is equal");
  let m = mls.encryptApplication(a2, utf8("cloned"));
  same(step(b2, m.message).data, utf8("cloned"), "clone decrypts");
  let c10 = mls.createCommit(b2, { proposals: [mls.proposeAdd(person("erin").kp.keyPackage)] });
  let a3 = step(m.state, c10.message).state;
  agree([a3, c10.state], "clones advance");
  ok(mls.members(a3).length === 3 && mls.members(a3)[2].index === 2, "freed leaf reused");
});

test("pending proposals and competing branches", () => {
  let [alice, bob, carol] = ["alice", "bob", "carol"].map(person);
  let a = mls.createGroup({
    groupId: utf8("branches"),
    sig: alice.sig,
    identity: "alice",
    capabilities: caps,
    extensions: groupExtensions,
  });
  let c1 = mls.createCommit(a, { proposals: [mls.proposeAdd(bob.kp.keyPackage)] });
  a = c1.state;
  let b = join(bob, c1.welcome);

  // proposals by reference: an add from bob, committed by alice
  let prop = mls.createProposal(b, mls.proposeAdd(carol.kp.keyPackage), { aad: utf8("p") });
  b = prop.state;
  let got = step(a, prop.message);
  same(got.aad, utf8("p"), "proposal aad");
  let held = got.state;
  let c2 = mls.createCommit(held);
  ok(c2.welcome && c2.addedRefs.length === 1, "pending add committed");
  // the same state can also commit without it: two candidate branches from one parent
  let alt = mls.createCommit(held, { includePending: false });
  ok(!alt.welcome && mls.members(alt.state).length === 2, "includePending: false");
  ok(
    hex(alt.state.confirmedTranscriptHash) !== hex(c2.state.confirmedTranscriptHash),
    "branches differ",
  );
  let viaAlt = step(b, alt.message).state;
  let viaC2 = step(b, c2.message);
  ok(
    viaC2.proposals[0].byRef && viaC2.proposals[0].sender === 1,
    "by-reference proposal keeps its sender",
  );
  agree([alt.state, viaAlt], "branch without the add");
  agree([c2.state, viaC2.state], "branch with the add");
  let c = join(carol, c2.welcome);
  agree([c2.state, c], "carol on the chosen branch");

  // a commit whose proposal we never saw
  throws(() => step(a, mls.createCommit(b).message.slice(0, 20)), "truncated message");
  let fresh = step(a, mls.createCommit(b, { includePending: false }).message).state;
  ok(fresh.epoch === a.epoch + 1, "bob's own commit applies to alice's un-proposed state");
  throws(
    () => step(a, mls.createCommit(b).message),
    "commit referencing an unseen proposal",
    "missing-proposal",
  );

  // a path-less commit (adds only) is accepted, and the joiner works without a path secret
  let dave = person("dave");
  let lean = mls.createCommit(c2.state, {
    proposals: [mls.proposeAdd(dave.kp.keyPackage)],
    path: false,
  });
  let d = join(dave, lean.welcome);
  let b3 = step(viaC2.state, lean.message).state;
  agree([lean.state, b3, d], "path-less add");
  let next = mls.createCommit(d);
  agree(
    [next.state, step(lean.state, next.message).state, step(b3, next.message).state],
    "commit by the path-less joiner",
  );

  // handshake messages may also arrive as PrivateMessage
  let content = {
    groupId: b3.groupId,
    epoch: b3.epoch,
    sender: { type: 1, leafIndex: b3.leafIndex },
    aad: EMPTY,
    contentType: 2,
    proposal: mls.proposeRemove(3),
  };
  let sealed = I.framing.sealPrivate(b3, content, {
    signature: I.framing.signContent(b3, 2, content),
  });
  let viaPrivate = step(lean.state, sealed.message);
  ok(
    viaPrivate.type === "proposal" && viaPrivate.proposal.removed === 3,
    "private proposal accepted",
  );
  let removal = mls.createCommit(viaPrivate.state);
  ok(mls.members(removal.state).length === 3, "privately proposed remove committed");

  // members must support every non-default proposal type a commit uses
  let plain = person("plain");
  plain.kp = mls.generateKeyPackage({ sig: plain.sig, identity: "plain" });
  let g = mls.createGroup({
    groupId: utf8("plain"),
    sig: alice.sig,
    identity: "alice",
    capabilities: caps,
  });
  let both = mls.createCommit(g, { proposals: [mls.proposeAdd(plain.kp.keyPackage)] });
  throws(
    () => mls.createCommit(both.state, { proposals: [mls.proposeAppEphemeral(1, EMPTY)] }),
    "proposal type one member lacks",
  );
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeAdd(plain.kp.keyPackage)] }),
    "add without the required capabilities",
  );
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeAdd(bob.kp.keyPackage)] }),
    "add of a current member",
  );
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeRemove(0)] }),
    "committer removing itself",
  );
  throws(
    () => mls.createCommit(a, { proposals: [mls.proposeRemove(9)] }),
    "remove of a blank leaf",
  );
  throws(
    () => mls.createCommit(a, { proposals: [{ type: 0x0a0a, data: EMPTY }] }),
    "unknown proposal type",
    "unsupported",
  );
  throws(
    () =>
      mls.createCommit(a, {
        proposals: [
          { type: PROPOSAL.REINIT, groupId: EMPTY, version: 1, cipherSuite: 1, extensions: [] },
        ],
      }),
    "reinit",
    "unsupported",
  );
  let expired = mls.generateKeyPackage({
    sig: mls.generateSignatureKeyPair(),
    identity: "old",
    capabilities: caps,
    lifetime: { notBefore: 1, notAfter: 2 },
  });
  mls.createCommit(a, { proposals: [mls.proposeAdd(expired.keyPackage)] });
  throws(
    () =>
      mls.createCommit(a, {
        proposals: [mls.proposeAdd(expired.keyPackage)],
        now: Math.floor(Date.now() / 1000),
      }),
    "expired key package with the lifetime check on",
    "lifetime",
  );
});

suite("self-tests", tests, (t) => {
  try {
    t.fn();
  } catch (e) {
    throw new Error(`${t.name}: ${e.message}`);
  }
});

console.log("\n" + results.join("\n"));
console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
process.exit(failed ? 1 : 0);
