// One request, one answerer per origin.
//
// Every open tab of the same wallet (and its service worker) sees every NWC
// request. Without exclusion two hidden tabs on one laptop both paid a zap:
// the loser's "payment already in progress" error reached the client half a
// second before the winner's preimage, and the zap showed as failed while
// the sats had gone. Web Locks are shared by every same-origin context, so
// the first to claim a request's lock answers it and the rest stay quiet.
// Where locks are unavailable (tests, ancient engines) the caller just runs.
export async function withRequestLock(id, fn, held = () => undefined) {
  const locks = typeof navigator !== 'undefined' && navigator.locks;
  if (!locks || !id) return fn();
  return locks.request(`nwc-req:${id}`, { ifAvailable: true }, (lock) => (lock ? fn() : held()));
}
