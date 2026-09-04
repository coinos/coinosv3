// Off-main-thread nostr event verification. Schnorr signature checks (real
// secp256k1) on a relay backlog blocked the UI on boot / when a community
// opens — the carousel-stutter cause a CPU profile pinned to verifyEvent. This
// worker does that work on another thread; the main thread posts events and
// gets back a boolean per event, so the page never freezes on a burst.
//
// Bundled to dist/verify-worker.js (see build.js) and loaded as a classic
// Worker. Same verifyEvent nostr-tools uses on the main thread, so semantics
// are identical — this only moves WHERE it runs.
import { verifyEvent } from 'nostr-tools/pure';

self.onmessage = (e) => {
  const { reqId, events } = e.data || {};
  if (reqId == null || !Array.isArray(events)) return;
  const results = events.map((ev) => {
    try { return verifyEvent(ev); } catch { return false; }
  });
  self.postMessage({ reqId, results });
};
