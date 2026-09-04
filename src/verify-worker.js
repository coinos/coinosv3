// Off-main-thread nostr crypto. Schnorr signature checks (real secp256k1) on
// a relay backlog blocked the UI on boot / when a community opens — the
// carousel-stutter cause a CPU profile pinned to verifyEvent. This worker
// does that work on another thread; the main thread posts events and gets
// back a boolean per event, so the page never freezes on a burst.
//
// It also carries the other boot secp256k1 the profiler kept pinning:
//  - 'openWraps': community (Concord) wraps — nip44 decrypt under the
//    symmetric stream key + the seal's schnorr verify + hash checks. No
//    secret crosses the thread boundary: the stream conversation key is
//    group material every member derives.
//  - 'unwrapDMs': NIP-17 gift wraps when the wallet holds the raw identity
//    key (seed-derived / pasted nsec) — two ECDH ops + a seal verify each.
//    Remote signers (bunker/extension) can't export their key, so their
//    wraps never come here; the main thread keeps that path.
//
// Bundled to dist/verify-worker.js (see build.js). Same openWrap/unwrapDM/
// verifyEvent the main thread uses, so semantics are identical — this only
// moves WHERE they run.
import { verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import { openWrap } from './concord.js';
import { unwrapDM } from './dm.js';

self.onmessage = async (e) => {
  const { reqId, events, op, wraps, convKey, sk } = e.data || {};
  if (reqId == null) return;
  if (Array.isArray(events)) {
    const results = events.map((ev) => {
      try { return verifyEvent(ev); } catch { return false; }
    });
    self.postMessage({ reqId, results });
    return;
  }
  if (op === 'openWraps' && Array.isArray(wraps)) {
    let stream = null;
    try { stream = { convKey: hexToBytes(convKey) }; } catch {}
    const results = wraps.map((w) => {
      try { return stream ? openWrap(w, stream) : null; } catch { return null; }
    });
    self.postMessage({ reqId, results });
    return;
  }
  if (op === 'unwrapDMs' && Array.isArray(wraps)) {
    let key = null;
    try { key = hexToBytes(sk); } catch {}
    const results = [];
    for (const w of wraps) {
      results.push(key ? await unwrapDM(w, key).catch(() => null) : null);
    }
    self.postMessage({ reqId, results });
    return;
  }
  self.postMessage({ reqId, results: null });
};
